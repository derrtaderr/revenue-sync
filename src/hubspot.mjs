// Minimal HubSpot CRM v3 client for companies and company properties. The token lives only in
// the Authorization header. Error messages are built from status codes, endpoint paths and
// HubSpot's error category, never from request headers or message bodies.

import { createRequester, ApiError } from './http.mjs';

const BASE = 'https://api.hubapi.com';
export const BATCH_LIMIT = 100;

export const SCOPES = ['crm.objects.companies.read', 'crm.objects.companies.write', 'crm.schemas.companies.read', 'crm.schemas.companies.write'];

// A HubSpot service key or private app token is printable ASCII with no spaces or quotes.
// A HubSpot service key or private app token (pat-<region>-<uuid>) is letters, digits and
// hyphens; dots and underscores are allowed for older token shapes. Nothing else.
export function validToken(token) {
  return typeof token === 'string' && /^[A-Za-z0-9._-]+$/.test(token);
}

export const BAD_TOKEN_MESSAGE = 'HUBSPOT_TOKEN contains characters a HubSpot token never has (anything other than letters, digits, hyphens, dots or underscores). This usually means quotes, a space, a "Bearer " prefix or a placeholder was pasted with it. Copy the token again from HubSpot and paste only the token.';

const category = (body) => (typeof body?.category === 'string' && /^[A-Z_]+$/.test(body.category) ? body.category : null);

function errorFor(status, path, body) {
  if (status === 401) return new ApiError('HubSpot rejected the token (401). Check that HUBSPOT_TOKEN holds a current service key or private app token for this portal.', 401);
  if (status === 403) return new ApiError(`HubSpot refused ${path} (403). The token needs these scopes: ${SCOPES.join(', ')}.`, 403);
  const cat = category(body);
  return new ApiError(`HubSpot request to ${path} failed with status ${status}${cat ? ` (${cat})` : ''}.`, status);
}

function results(body, path) {
  if (!Array.isArray(body?.results)) throw new ApiError(`HubSpot returned an unexpected list shape from ${path} (no results array). Nothing was written.`);
  return body.results;
}

const chunk = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export function createHubSpotClient({ token, fetch, sleep, random, baseUrl = BASE }) {
  const request = createRequester({ service: 'HubSpot', fetch, sleep, random });

  async function call(method, path, { params, body, allow404 = false } = {}) {
    if (!validToken(token)) throw new ApiError(BAD_TOKEN_MESSAGE);
    let headers;
    try {
      headers = new Headers({ authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) });
    } catch {
      throw new ApiError(BAD_TOKEN_MESSAGE);
    }
    const url = new URL(path, baseUrl);
    for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    const res = await request(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (res.status === 404 && allow404) return null;
    if (res.status >= 200 && res.status < 300) return { status: res.status, body: res.body };
    throw errorFor(res.status, path, res.body);
  }

  async function listCompanies(properties) {
    const out = [];
    let after;
    do {
      const { body } = await call('GET', '/crm/v3/objects/companies', { params: { limit: '100', properties: properties.join(','), after } });
      out.push(...results(body, '/crm/v3/objects/companies'));
      after = body?.paging?.next?.after;
    } while (after);
    return out;
  }

  async function batchRead(ids, properties) {
    const out = [];
    for (const part of chunk(ids, BATCH_LIMIT)) {
      const { body } = await call('POST', '/crm/v3/objects/companies/batch/read', { body: { properties, inputs: part.map((id) => ({ id: String(id) })) } });
      out.push(...results(body, '/crm/v3/objects/companies/batch/read'));
    }
    return out;
  }

  // One batch. Returns { ok: [ids], failed: [{ id, reason }] }. On a 207 the documented shape
  // is only partly confirmed, so any input whose id is not in results counts as failed.
  async function batchUpdate(inputs) {
    if (inputs.length > BATCH_LIMIT) throw new ApiError(`A HubSpot batch update takes at most ${BATCH_LIMIT} inputs; got ${inputs.length}.`);
    const { body } = await call('POST', '/crm/v3/objects/companies/batch/update', { body: { inputs } });
    const landed = new Set((body?.results ?? []).map((r) => String(r.id)));
    const reasons = new Map();
    for (const e of body?.errors ?? []) for (const id of e?.context?.ids ?? []) reasons.set(String(id), category(e) ?? 'error');
    const ok = [];
    const failed = [];
    for (const i of inputs) {
      const id = String(i.id);
      if (landed.has(id)) ok.push(id);
      else failed.push({ id, reason: reasons.get(id) ?? 'not in HubSpot results' });
    }
    return { ok, failed };
  }

  async function batchCreate(inputs) {
    const out = [];
    for (const part of chunk(inputs, BATCH_LIMIT)) {
      const { body } = await call('POST', '/crm/v3/objects/companies/batch/create', { body: { inputs: part } });
      out.push(...(body?.results ?? []));
    }
    return out;
  }

  return {
    listCompanies,
    batchRead,
    batchUpdate,
    batchCreate,
    getProperty: async (name) => (await call('GET', `/crm/v3/properties/companies/${encodeURIComponent(name)}`, { allow404: true }))?.body ?? null,
    getGroup: async (name) => (await call('GET', `/crm/v3/properties/companies/groups/${encodeURIComponent(name)}`, { allow404: true }))?.body ?? null,
    createGroup: async (group) => (await call('POST', '/crm/v3/properties/companies/groups', { body: { displayOrder: -1, ...group } })).body,
    createProperty: async (def) => (await call('POST', '/crm/v3/properties/companies', { body: def })).body,
  };
}
