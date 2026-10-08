// BigQuery, with no dependency: run one SQL query through the REST API and return typed rows.
// Shapes are from the BigQuery v2 discovery document and the jobs.query and getQueryResults
// pages (docs/SPEC.md, "BigQuery API shapes this build reads"). Fail closed: anything that is not
// the documented shape throws, so a short or malformed read can never look like "no customers".

import { randomUUID } from 'node:crypto';
import { ApiError, createRequester } from './http.mjs';
import { BIGQUERY_SCOPE } from './google-auth.mjs';

const INT = /^-?\d+$/;
const DECIMAL = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The wire form of each scalar type (rows are {f: [{v}]}; NULL is {v: null}). INT64, NUMERIC and
// BIGNUMERIC are strings and stay strings so no precision is lost; TIMESTAMP is float64 seconds
// since the epoch (the default timestampOutputFormat), as a string.
const SCALAR = {
  STRING: (v) => (typeof v === 'string' ? v : undefined),
  BYTES: (v) => (typeof v === 'string' ? v : undefined),
  JSON: (v) => (typeof v === 'string' ? v : undefined),
  GEOGRAPHY: (v) => (typeof v === 'string' ? v : undefined),
  TIME: (v) => (typeof v === 'string' ? v : undefined),
  DATETIME: (v) => (typeof v === 'string' ? v : undefined),
  DATE: (v) => (typeof v === 'string' && DATE.test(v) ? v : undefined),
  INTEGER: (v) => (typeof v === 'string' && INT.test(v) ? v : undefined),
  NUMERIC: (v) => (typeof v === 'string' && DECIMAL.test(v) ? v : undefined),
  FLOAT: (v) => (typeof v === 'string' && (DECIMAL.test(v) || ['NaN', 'Infinity', '-Infinity'].includes(v)) ? Number(v) : undefined),
  BOOLEAN: (v) => (v === 'true' ? true : v === 'false' ? false : undefined),
  TIMESTAMP: (v) => (typeof v === 'string' && DECIMAL.test(v) ? Number(v) : undefined),
};
const ALIAS = { INT64: 'INTEGER', FLOAT64: 'FLOAT', BOOL: 'BOOLEAN', BIGNUMERIC: 'NUMERIC', STRUCT: 'RECORD' };
export const baseType = (type) => ALIAS[type] ?? type;

const bad = (message) => new ApiError(`BigQuery returned ${message}. Nothing was written.`);

function checkSchema(fields, path = '') {
  if (!Array.isArray(fields)) throw bad('no schema for the result');
  const seen = new Set();
  for (const fd of fields) {
    const name = `${path}${fd?.name}`;
    if (typeof fd?.name !== 'string') throw bad('a schema field with no name');
    if (seen.has(fd.name)) throw bad(`a result where column ${name} appears twice`);
    seen.add(fd.name);
    const t = baseType(fd.type);
    if (t === 'RECORD') checkSchema(fd.fields, `${name}.`);
    else if (!SCALAR[t]) throw new ApiError(`BigQuery column ${name} has type ${fd.type}, which this tool does not read. Cast it in the SQL (for example to STRING or NUMERIC). Nothing was written.`);
  }
}

function decodeValue(fd, v, where) {
  if (v === null || v === undefined) return null;
  if (fd.mode === 'REPEATED') {
    if (!Array.isArray(v)) throw bad(`a REPEATED value that is not a list at ${where}`);
    return v.map((cell) => decodeValue({ ...fd, mode: 'NULLABLE' }, cell?.v, where));
  }
  if (baseType(fd.type) === 'RECORD') return decodeRecord(fd.fields, v, where);
  const out = SCALAR[baseType(fd.type)](v);
  if (out === undefined) throw bad(`a ${fd.type} value it does not document (${JSON.stringify(v).slice(0, 40)}) at ${where}`);
  return out;
}

function decodeRecord(fields, r, where) {
  if (!r || !Array.isArray(r.f)) throw bad(`${where} not in BigQuery's {f: [...]} shape`);
  if (r.f.length !== fields.length) throw bad(`${where.replace(/,.*$/, '')} has ${r.f.length} values, the schema has ${fields.length}`);
  const out = {};
  fields.forEach((fd, i) => { out[fd.name] = decodeValue(fd, r.f[i]?.v, `${where}, column ${fd.name}`); });
  return out;
}

export function decodeRows(fields, rows) {
  checkSchema(fields);
  return rows.map((r, i) => {
    if (!r || !Array.isArray(r.f)) throw bad(`row ${i + 1} is not in BigQuery's {f: [...]} shape`);
    return decodeRecord(fields, r, `row ${i + 1}`);
  });
}

// ---- the client ----


export const BIGQUERY_BASE = 'https://bigquery.googleapis.com';
export const POLL_TIMEOUT_MS = 10000;
export const MAX_POLLS = 30; // 30 server-side waits of 10 seconds: a bounded 5 minutes.

const clean = (text) => String(text ?? '').replace(/[^\x20-\x7e]/g, ' ').replace(/ya29\.[\w.-]+/g, '[redacted]').slice(0, 300);
const reasonOf = (body) => {
  const r = body?.error?.errors?.[0]?.reason;
  return typeof r === 'string' && /^[A-Za-z]+$/.test(r) ? r : null;
};

// Insufficient OAuth scope, as Google reports it: the legacy errors[] reason, or a
// google.rpc.ErrorInfo detail (cloud.google.com/apis/design/errors). IAM roles cannot fix it.
const scopeInsufficient = (body, reason) => reason === 'insufficientPermissions'
  || (Array.isArray(body?.error?.details) && body.error.details.some((d) => d?.reason === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'));

// A table backed by Google Drive or Sheets needs a Drive scope this tool never requests; BigQuery
// answers accessDenied "... while getting Drive credentials" (docs/SPEC.md divergence 34).
const driveBacked = (body) => /Drive credentials/i.test(String(body?.error?.message ?? ''));

function errorFor(status, path, body) {
  const reason = reasonOf(body);
  if (status === 401) return new ApiError('BigQuery rejected the access token (401). Check the service account key.', 401);
  if (status === 403 && driveBacked(body)) {
    return new ApiError(`BigQuery refused ${path} (403${reason ? `, ${reason}` : ''}): the SQL reads a table backed by Google Drive or Sheets, which needs a Drive scope revenue-sync never requests, so granting IAM roles will not fix it. Drive-backed external tables are not supported; copy the data into a native BigQuery table and query that.`, 403);
  }
  if (status === 403 && scopeInsufficient(body, reason)) {
    return new ApiError(`BigQuery refused ${path} (403, ${reason ?? 'ACCESS_TOKEN_SCOPE_INSUFFICIENT'}): the access token's scope does not cover this request (token scope), so granting IAM roles will not fix it. revenue-sync asks for ${BIGQUERY_SCOPE}, which ran BigQuery queries in a live check; please report this in GitHub Issues with the reason shown.`, 403);
  }
  if (status === 403 && reason !== 'rateLimitExceeded' && reason !== 'quotaExceeded') {
    return new ApiError(`BigQuery refused ${path} (403${reason ? `, ${reason}` : ''}). The service account needs the BigQuery Job User role on the project and BigQuery Data Viewer on the datasets the SQL reads.`, 403);
  }
  // Google's message on a 400 or 404 describes the SQL or the missing table; a user cannot fix the
  // query without it. It never carries a credential (and an access token is redacted anyway).
  if ((status === 400 || status === 404) && body?.error?.message) return new ApiError(`BigQuery refused the query (${status}${reason ? `, ${reason}` : ''}): ${clean(body.error.message)}`, status);
  return new ApiError(`BigQuery request to ${path} failed with status ${status}${reason ? ` (${reason})` : ''}.`, status);
}

export function createBigQueryClient({ tokens, project, location, fetch, sleep, random, baseUrl = BIGQUERY_BASE }) {
  const request = createRequester({ service: 'BigQuery', fetch, sleep, random });

  async function call(method, path, { params, body } = {}) {
    const url = new URL(`/bigquery/v2/projects/${encodeURIComponent(project)}${path}`, baseUrl);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    const headers = { authorization: `Bearer ${await tokens.token()}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) };
    const res = await request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status >= 200 && res.status < 300) {
      // Job errors can arrive in a 200 answer. Google says some may be warnings; this tool does
      // not guess which, so any entry fails the read.
      if (Array.isArray(res.body?.errors) && res.body.errors.length) {
        const e = res.body.errors[0];
        const reason = typeof e?.reason === 'string' && /^[A-Za-z]+$/.test(e.reason) ? e.reason : 'error';
        throw new ApiError(`BigQuery reported an error running the query (${reason}): ${clean(e?.message)}. Nothing was written.`);
      }
      return res.body;
    }
    throw errorFor(res.status, `projects/${project}/queries`, res.body);
  }

  return {
    async query(sql) {
      const where = location ? { location } : {};
      // The SQL may only read. A dry run validates it and reports its statement type without running
      // anything; anything but a SELECT (DML, DDL, a script) is refused before it can run.
      const dry = await call('POST', '/queries', { body: { query: sql, useLegacySql: false, dryRun: true, ...where } });
      if (typeof dry?.statementType !== 'string') throw new ApiError('BigQuery did not say what kind of statement the SQL is, so it was not run. Nothing was written.');
      if (dry.statementType !== 'SELECT') throw new ApiError(`revenue-sync only runs a SELECT; BigQuery says this SQL is ${dry.statementType.replace(/[^A-Z_]/g, '')}. It was not run. Nothing was written.`);
      // One requestId for the request and its retries. Google documents it as idempotency for
      // mutating queries and says read-only queries may ignore it, so a retried 5xx may still be
      // billed twice; it is sent so that a duplicate is never worse than that.
      let page = await call('POST', '/queries', { body: { query: sql, useLegacySql: false, ...where, timeoutMs: POLL_TIMEOUT_MS, requestId: randomUUID() } });
      const job = page?.jobReference;
      if (typeof job?.jobId !== 'string') throw bad('a query answer with no jobReference');
      const next = (pageToken) => call('GET', `/queries/${encodeURIComponent(job.jobId)}`, { params: { location: job.location ?? location, timeoutMs: POLL_TIMEOUT_MS, pageToken } });
      for (let polls = 0; page?.jobComplete !== true; polls++) {
        if (page?.jobComplete !== false) throw bad('an answer with no jobComplete flag');
        if (polls >= MAX_POLLS) throw new ApiError(`The BigQuery query is still running after ${Math.round((MAX_POLLS * POLL_TIMEOUT_MS) / 60000)} minutes (job ${job.jobId}). Nothing was written. Try again, or make the query cheaper.`);
        page = await next();
      }
      const fields = page.schema?.fields;
      if (!Array.isArray(fields)) throw bad('a completed query with no schema');
      if (typeof page.totalRows !== 'string' || !/^\d+$/.test(page.totalRows)) throw bad('a completed query with no totalRows');
      const total = Number(page.totalRows);
      const raw = [];
      const seen = new Set();
      for (;;) {
        if (page.jobComplete !== true) throw bad('an incomplete page in the middle of a completed result');
        if (Array.isArray(page.rows)) raw.push(...page.rows);
        else if (page.rows !== undefined) throw bad('rows that are not a list');
        else if (raw.length < total && !page.pageToken) throw bad(`a page where totalRows says ${total} but sent no rows`);
        if (!page.pageToken) break;
        if (seen.has(page.pageToken)) throw bad('the same pageToken twice');
        seen.add(page.pageToken);
        page = await next(page.pageToken);
      }
      if (raw.length !== total) throw bad(`${raw.length} of ${total} rows`);
      return { fields, rows: decodeRows(fields, raw), job: job.jobId };
    },
  };
}
