// An in-process stand-in for the HubSpot CRM v3 API, used as an injected fetch. It reproduces
// the shapes this tool uses: company list paging on paging.next.after, property values as
// strings (numbers come back normalised, so "1250.00" reads back as "1250"), unknown requested
// properties silently ignored, batch read and update (at most 100 inputs; 207 with errors[] for
// missing ids; 400 for an unknown property), properties and property groups (404 when missing),
// and the 429 body HubSpot documents (no Retry-After).
//
// failures['METHOD /path'] is a queue: a number is answered with that status; a function gets
// the real handler, so a test can let a write land and then drop the connection.

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const error = (status, category, message, extra = {}) => json(status, { status: 'error', message, correlationId: 'c0ffee00-0000-4000-8000-000000000000', category, ...extra });

const BUILT_IN = {
  name: { name: 'name', label: 'Company name', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
  domain: { name: 'domain', label: 'Company domain name', type: 'string', fieldType: 'text', groupName: 'companyinformation' },
  hs_additional_domains: { name: 'hs_additional_domains', label: 'Additional domains', type: 'enumeration', fieldType: 'checkbox', groupName: 'companyinformation' },
};

// wholeBatchNotFound: answer a batch update naming any missing id with a whole-batch 404, as
// HubSpot may do, instead of a partial 207.
export function createFakeHubSpot({ token, now = '2026-10-07T12:00:00.000Z', wholeBatchNotFound = false } = {}) {
  const companies = [];
  const properties = structuredClone(BUILT_IN);
  const groups = { companyinformation: { name: 'companyinformation', label: 'Company information', displayOrder: -1 } };
  const failures = {};
  const requests = [];
  let seq = 100;

  function addCompany(props) {
    const c = { id: String(seq++), properties: { ...props }, createdAt: now, updatedAt: now, archived: false };
    companies.push(c);
    return c;
  }

  function normalise(name, value) {
    if (value === null || value === '') return '';
    const def = properties[name];
    if (def?.type === 'number') {
      if (!/^-?\d+(\.\d+)?$/.test(String(value))) return { invalid: `${value} is not a valid number` };
      return String(Number(value));
    }
    if (def?.type === 'date') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
      if (/^\d+$/.test(value) && Number(value) % 86400000 === 0) return new Date(Number(value)).toISOString().slice(0, 10);
      return { invalid: `${value} is not a valid date (midnight UTC)` };
    }
    return String(value);
  }

  function view(c, wanted) {
    const props = { hs_object_id: c.id, createdate: c.createdAt, hs_lastmodifieddate: c.updatedAt };
    for (const p of wanted) if (properties[p]) props[p] = c.properties[p] ?? null;
    return { id: c.id, properties: props, createdAt: c.createdAt, updatedAt: c.updatedAt, archived: false };
  }

  async function handle(method, path, q, body) {
    if (method === 'GET' && path === '/crm/v3/objects/companies') {
      const limit = Math.min(Number(q.get('limit') ?? 10), 100);
      const start = Number(q.get('after') ?? 0);
      const wanted = (q.get('properties') ?? '').split(',').filter(Boolean);
      const page = companies.slice(start, start + limit).map((c) => view(c, wanted));
      const next = start + limit < companies.length ? { paging: { next: { after: String(start + limit), link: `?after=${start + limit}` } } } : {};
      return json(200, { results: page, ...next });
    }
    if (method === 'POST' && /^\/crm\/v3\/objects\/companies\/batch\/(read|update|create)$/.test(path)) {
      const kind = path.split('/').pop();
      const inputs = body?.inputs ?? [];
      if (inputs.length > 100) return error(400, 'VALIDATION_ERROR', 'Batch input must contain at most 100 inputs.');
      if (kind === 'read') {
        const found = inputs.map((i) => companies.find((c) => c.id === String(i.id))).filter(Boolean);
        return json(200, { status: 'COMPLETE', results: found.map((c) => view(c, body.properties ?? [])), startedAt: now, completedAt: now });
      }
      for (const input of inputs) {
        for (const [name, value] of Object.entries(input.properties ?? {})) {
          if (!properties[name]) return error(400, 'VALIDATION_ERROR', 'Property values were not valid', { errors: [{ message: `Property "${name}" does not exist`, code: 'PROPERTY_DOESNT_EXIST', context: { propertyName: [name] } }] });
          const v = normalise(name, value);
          if (typeof v === 'object') return error(400, 'VALIDATION_ERROR', 'Property values were not valid', { errors: [{ message: v.invalid, code: 'INVALID_' + properties[name].type.toUpperCase() }] });
        }
      }
      if (kind === 'create') {
        const created = inputs.map((i) => addCompany(Object.fromEntries(Object.entries(i.properties).map(([k, v]) => [k, normalise(k, v)]))));
        return json(201, { status: 'COMPLETE', results: created.map((c) => view(c, Object.keys(c.properties))), startedAt: now, completedAt: now });
      }
      if (wholeBatchNotFound && inputs.some((i) => !companies.find((x) => x.id === String(i.id)))) return error(404, 'OBJECT_NOT_FOUND', 'Could not get some COMPANY objects, they may be deleted or not exist.');
      const results = [];
      const errors = [];
      for (const input of inputs) {
        const c = companies.find((x) => x.id === String(input.id));
        if (!c) {
          // Exactly the error object HubSpot returned live on 2026-10-07 (207, status COMPLETE).
          errors.push({ status: 'error', category: 'OBJECT_NOT_FOUND', context: { ids: [String(input.id)] } });
          continue;
        }
        for (const [name, value] of Object.entries(input.properties)) c.properties[name] = normalise(name, value);
        results.push(view(c, Object.keys(input.properties)));
      }
      const base = { status: 'COMPLETE', results, startedAt: now, completedAt: now };
      return errors.length ? json(207, { ...base, numErrors: errors.length, errors }) : json(200, base);
    }
    let m = /^\/crm\/v3\/properties\/companies\/groups(?:\/([^/]+))?$/.exec(path);
    if (m) {
      if (method === 'GET') return groups[m[1]] ? json(200, groups[m[1]]) : error(404, 'OBJECT_NOT_FOUND', `Unable to find property group ${m[1]}`);
      if (method === 'POST') {
        if (!body?.name || !body?.label) return error(400, 'VALIDATION_ERROR', 'name and label are required');
        if (groups[body.name]) return error(409, 'CONFLICT', `A property group named ${body.name} already exists`);
        groups[body.name] = { name: body.name, label: body.label, displayOrder: body.displayOrder ?? -1 };
        return json(201, groups[body.name]);
      }
    }
    m = /^\/crm\/v3\/properties\/companies(?:\/([^/]+))?$/.exec(path);
    if (m) {
      if (method === 'GET' && m[1]) return properties[m[1]] ? json(200, properties[m[1]]) : error(404, 'OBJECT_NOT_FOUND', `Unable to find property ${m[1]}`);
      if (method === 'POST' && !m[1]) {
        for (const f of ['name', 'label', 'type', 'fieldType', 'groupName']) if (!body?.[f]) return error(400, 'VALIDATION_ERROR', `${f} is required`);
        const valid = { number: ['number'], date: ['date'], string: ['text', 'textarea'], enumeration: ['select', 'radio', 'checkbox'] };
        if (!valid[body.type]?.includes(body.fieldType)) return error(400, 'VALIDATION_ERROR', `fieldType ${body.fieldType} is not valid for type ${body.type}`);
        if (!groups[body.groupName]) return error(400, 'VALIDATION_ERROR', `Property group ${body.groupName} does not exist`);
        if (properties[body.name]) return error(409, 'CONFLICT', `Property ${body.name} already exists`);
        properties[body.name] = { ...body };
        return json(201, properties[body.name]);
      }
    }
    return error(404, 'OBJECT_NOT_FOUND', `No route for ${method} ${path}`);
  }

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = init.body ? JSON.parse(init.body) : null;
    requests.push({ method, path: u.pathname, query: u.search, headers: Object.fromEntries(headers), body });
    const real = () => handle(method, u.pathname, u.searchParams, body);
    const queue = failures[`${method} ${u.pathname}`];
    if (queue?.length) {
      const f = queue.shift();
      if (typeof f === 'function') return f(real);
      if (f === 429) return error(429, 'RATE_LIMITS', 'You have reached your secondly limit.', { errorType: 'RATE_LIMIT', policyName: 'SECONDLY' });
      return error(f, 'INTERNAL_ERROR', 'internal error');
    }
    if (headers.get('authorization') !== `Bearer ${token}`) return error(401, 'INVALID_AUTHENTICATION', 'Authentication credentials not found.');
    return real();
  };

  return { fetch, companies, properties, groups, failures, requests, addCompany };
}
