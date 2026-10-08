// An in-process stand-in for Google's OAuth2 token endpoint and the BigQuery v2 query API, used
// as an injected fetch. It reproduces the documented shapes AND the documented omissions
// (docs/SPEC.md, "What the fake BigQuery reproduces"):
//   token: form POST, JWT checked (RS256 signature against the public key, iss, aud, scope,
//     exp at most an hour after iat), answer {access_token, token_type, expires_in}, errors
//     {error, error_description}.
//   jobs.query dryRun: {statementType, totalBytesProcessed}, no rows and no job.
//   jobs.query / getQueryResults: rows as {f:[{v}]}, NULL as {v:null}, totalRows a string,
//     rows OMITTED when totalRows is "0", jobComplete false with no rows, totalRows or schema
//     until `pending` polls have passed, pageToken paging at `pageSize`, errors as
//     {error:{code,message,errors:[{reason,message}]}}.
//
// results: register a result set per SQL text: fake.results.set(sql, { fields, rows, pending,
// pageSize }), where rows are plain arrays of cell values already in BigQuery's wire form
// (strings for INT64, NUMERIC and TIMESTAMP; null for NULL). failures['METHOD path'] is a queue
// of statuses or functions, as in the other fakes.
import { createVerify } from 'node:crypto';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=UTF-8' } });
export const googleError = (code, reason, message) => json(code, { error: { code, message, errors: [{ message, domain: 'global', reason }], status: { 400: 'INVALID_ARGUMENT', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND' }[code] ?? 'UNKNOWN' } });
const tokenError = (status, error, description) => json(status, { error, error_description: description });

const b64 = (s) => Buffer.from(s, 'base64url');

export function createFakeBigQuery({ key, publicKey, now = () => Date.UTC(2026, 9, 7, 9) } = {}) {
  const results = new Map();
  const jobs = new Map();
  const failures = {};
  const requests = [];
  const tokens = new Set();
  let seq = 0;

  function token(body) {
    const form = new URLSearchParams(body);
    if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') return tokenError(400, 'unsupported_grant_type', 'Invalid grant_type: ');
    const parts = (form.get('assertion') ?? '').split('.');
    if (parts.length !== 3) return tokenError(400, 'invalid_grant', 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.');
    let header; let claims;
    try { header = JSON.parse(b64(parts[0])); claims = JSON.parse(b64(parts[1])); } catch { return tokenError(400, 'invalid_grant', 'Invalid JWT.'); }
    const verify = createVerify('RSA-SHA256');
    verify.update(`${parts[0]}.${parts[1]}`);
    if (header.alg !== 'RS256' || header.typ !== 'JWT' || !verify.verify(publicKey, b64(parts[2]))) return tokenError(400, 'invalid_grant', 'Invalid JWT Signature.');
    if (header.kid !== key.private_key_id) return tokenError(400, 'invalid_grant', 'Invalid key id.');
    const t = Math.floor(now() / 1000);
    if (claims.iss !== key.client_email) return tokenError(401, 'invalid_client', 'The OAuth client was not found.');
    if (claims.aud !== 'https://oauth2.googleapis.com/token') return tokenError(400, 'invalid_grant', 'Invalid JWT audience.');
    if (claims.scope !== 'https://www.googleapis.com/auth/cloud-platform.read-only') return tokenError(400, 'invalid_scope', 'Invalid OAuth scope or ID token audience provided.');
    if (!(claims.exp > claims.iat && claims.exp - claims.iat <= 3600 && Math.abs(claims.iat - t) < 300)) return tokenError(400, 'invalid_grant', 'Invalid JWT: Token must be a short-lived token (60 minutes) and in a reasonable timeframe.');
    const access = `ya29.fake-${++seq}-a0b1c2d3e4f5`;
    tokens.add(access);
    return json(200, { access_token: access, expires_in: 3599, token_type: 'Bearer' });
  }

  function page(job, pageToken, maxResults) {
    if (job.polls < job.pending) {
      job.polls++;
      return json(200, { kind: 'bigquery#getQueryResultsResponse', jobReference: job.ref, jobComplete: false });
    }
    const r = job.result;
    const size = Math.min(job.pageSize ?? r.rows.length, maxResults ?? Infinity) || 1;
    const start = pageToken ? Number(pageToken.replace('page-', '')) : 0;
    const slice = r.rows.slice(start, start + size);
    const body = { kind: 'bigquery#queryResponse', schema: { fields: r.fields }, jobReference: job.ref, totalRows: String(r.rows.length), jobComplete: true, cacheHit: false };
    // BigQuery omits rows entirely when there are none to return.
    if (slice.length) body.rows = slice.map((row) => ({ f: row.map((v) => ({ v: encode(v) })) }));
    if (start + size < r.rows.length) body.pageToken = `page-${start + size}`;
    return json(200, body);
  }

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    requests.push({ method, host: u.host, path: u.pathname, query: u.search, headers: Object.fromEntries(headers), body: init.body ?? null });
    const queue = failures[`${method} ${u.pathname}`];
    // 'pass' lets one request through to the normal handler, so a later entry hits a later request.
    if (queue?.length && queue[0] === 'pass') queue.shift();
    else if (queue?.length) {
      const f = queue.shift();
      if (typeof f === 'function') return f();
      return json(f, { error: { code: f, message: 'Backend error', errors: [{ reason: 'backendError', message: 'Backend error' }] } });
    }
    if (u.host === 'oauth2.googleapis.com' && u.pathname === '/token' && method === 'POST') return token(init.body ?? '');
    if (u.host !== 'bigquery.googleapis.com') return json(404, { error: 'not found' });
    const auth = headers.get('authorization') ?? '';
    if (!tokens.has(auth.replace(/^Bearer /, ''))) return googleError(401, 'authError', 'Request had invalid authentication credentials.');
    const q = /^\/bigquery\/v2\/projects\/([^/]+)\/queries$/.exec(u.pathname);
    if (q && method === 'POST') {
      const body = JSON.parse(init.body);
      if (body.useLegacySql !== false) return googleError(400, 'invalidQuery', 'Legacy SQL is not supported by this fake; send useLegacySql false.');
      const result = results.get(body.query);
      if (!result) return googleError(400, 'invalidQuery', 'Unrecognized name: no_such_table at [1:15]');
      if (result.error) return googleError(...result.error);
      // A dry run validates and reports the statement type; it runs nothing and returns no rows.
      if (body.dryRun === true) return json(200, { kind: 'bigquery#queryResponse', jobComplete: true, totalBytesProcessed: '0', statementType: result.statementType ?? 'SELECT', schema: { fields: result.fields } });
      const id = `job_${++seq}`;
      const job = { ref: { projectId: q[1], jobId: id, location: body.location ?? 'US' }, result, pending: result.pending ?? 0, polls: 0, pageSize: result.pageSize };
      jobs.set(id, job);
      return page(job, null, body.maxResults);
    }
    const g = /^\/bigquery\/v2\/projects\/([^/]+)\/queries\/([^/]+)$/.exec(u.pathname);
    if (g && method === 'GET') {
      const job = jobs.get(g[2]);
      if (!job) return googleError(404, 'notFound', `Not found: Job ${g[1]}:${g[2]}`);
      return page(job, u.searchParams.get('pageToken'), u.searchParams.get('maxResults') ? Number(u.searchParams.get('maxResults')) : undefined);
    }
    return googleError(404, 'notFound', 'Not found');
  };

  return { fetch, results, jobs, failures, requests, tokens };
}

// Plain JS values in the test tables become BigQuery's wire form: arrays are REPEATED
// ({v:[{v}]}), objects with an `f` array pass through as RECORD, everything else as is.
function encode(v) {
  if (Array.isArray(v)) return v.map((x) => ({ v: encode(x) }));
  return v;
}
