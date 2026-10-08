import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHubSpotClient, validToken } from '../src/hubspot.mjs';
import { createFakeHubSpot } from './helpers/fake-hubspot.mjs';
import { hubspotToken } from './helpers/keys.mjs';

const TOKEN = hubspotToken();
const make = (fake, token = TOKEN) => createHubSpotClient({ token, fetch: fake.fetch, sleep: async () => {}, random: () => 0 });

test('token shape: printable ASCII with no quotes or spaces', () => {
  assert.ok(validToken(TOKEN));
  assert.ok(!validToken('pat na1'));
  assert.ok(!validToken('"pat-na1-x"'));
  assert.ok(!validToken(''));
});

test('lists every company across pages with the requested properties', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  for (let i = 0; i < 250; i++) fake.addCompany({ name: `Co ${i}`, domain: `co${i}.example` });
  const list = await make(fake).listCompanies(['name', 'domain', 'rs_mrr']);
  assert.equal(list.length, 250);
  assert.equal(list[249].properties.domain, 'co249.example');
  assert.equal(fake.requests.length, 3);
  assert.match(decodeURIComponent(fake.requests[0].query), /properties=name,domain,rs_mrr/);
  assert.match(fake.requests[1].query, /after=100/);
  assert.equal(fake.requests[0].headers.authorization, `Bearer ${TOKEN}`);
});

test('batch reads companies by id, 100 at a time', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  const ids = Array.from({ length: 150 }, (_, i) => fake.addCompany({ name: `Co ${i}` }).id);
  const list = await make(fake).batchRead(ids, ['name']);
  assert.equal(list.length, 150);
  assert.deepEqual(fake.requests.map((r) => r.body.inputs.length), [100, 50]);
});

test('batch update reports which ids landed and which HubSpot rejected (207)', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  fake.properties.rs_plan = { name: 'rs_plan', type: 'string', fieldType: 'text' };
  const a = fake.addCompany({ name: 'A' });
  const r = await make(fake).batchUpdate([{ id: a.id, properties: { rs_plan: 'Pro' } }, { id: '999', properties: { rs_plan: 'Pro' } }]);
  assert.deepEqual(r.ok, [a.id]);
  assert.equal(r.failed.length, 1);
  assert.equal(r.failed[0].id, '999');
  assert.match(r.failed[0].reason, /OBJECT_NOT_FOUND/);
  assert.equal(a.properties.rs_plan, 'Pro');
});

test('batch update refuses more than 100 inputs before sending', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  await assert.rejects(make(fake).batchUpdate(Array.from({ length: 101 }, (_, i) => ({ id: String(i), properties: {} }))), /at most 100/);
  assert.equal(fake.requests.length, 0);
});

test('batch update 400 (for example an unknown property) is an error naming the HubSpot category', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  const a = fake.addCompany({ name: 'A' });
  await assert.rejects(make(fake).batchUpdate([{ id: a.id, properties: { rs_nope: '1' } }]), /status 400 \(VALIDATION_ERROR\)/);
});

test('reads a property and a property group, null when missing', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  const c = make(fake);
  assert.equal(await c.getProperty('rs_mrr'), null);
  assert.equal((await c.getProperty('domain')).name, 'domain');
  assert.equal(await c.getGroup('revenue_sync'), null);
});

test('creates a property group and a property', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  const c = make(fake);
  await c.createGroup({ name: 'revenue_sync', label: 'Revenue sync' });
  await c.createProperty({ name: 'rs_mrr', label: 'MRR', type: 'number', fieldType: 'number', groupName: 'revenue_sync' });
  assert.equal(fake.properties.rs_mrr.groupName, 'revenue_sync');
});

test('batch create returns the new companies', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  const made = await make(fake).batchCreate([{ properties: { name: 'X', domain: 'x.example' } }]);
  assert.equal(made.length, 1);
  assert.equal(fake.companies[0].properties.domain, 'x.example');
});

test('a 429 without Retry-After backs off and retries', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  fake.failures['GET /crm/v3/objects/companies'] = [429, 429];
  assert.deepEqual(await make(fake).listCompanies(['name']), []);
});

test('401 and 403 say what to fix, never echo the token', async () => {
  const fake = createFakeHubSpot({ token: 'other' });
  await assert.rejects(make(fake).listCompanies(['name']), (err) => {
    assert.match(err.message, /HubSpot rejected the token \(401\)/);
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
  const fake2 = createFakeHubSpot({ token: TOKEN });
  fake2.failures['POST /crm/v3/properties/companies'] = [403];
  await assert.rejects(make(fake2).createProperty({ name: 'x' }), /crm\.schemas\.companies\.write/);
});

test('an invalid token is refused before any request', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  await assert.rejects(make(fake, 'pat "x"').listCompanies(['name']), /HUBSPOT_TOKEN contains characters/);
  assert.equal(fake.requests.length, 0);
});

test('token check allows only the characters HubSpot tokens use (m3)', () => {
  for (const bad of ['pat-na1-x;y', '<paste token>', 'pat-na1-x”', 'Bearer pat-na1-x']) assert.ok(!validToken(bad), bad);
  assert.ok(validToken(['pat', 'eu1', '8c1f2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f'].join('-')));
});

test('a company page without a results array is an error, never an empty list (B4)', async () => {
  for (const body of [{}, { results: null }, { results: {} }]) {
    const fake = createFakeHubSpot({ token: TOKEN });
    fake.failures['GET /crm/v3/objects/companies'] = [() => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })];
    await assert.rejects(make(fake).listCompanies(['name']), /HubSpot returned an unexpected list shape from \/crm\/v3\/objects\/companies/);
  }
  const fake = createFakeHubSpot({ token: TOKEN });
  fake.failures['POST /crm/v3/objects/companies/batch/read'] = [() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })];
  await assert.rejects(make(fake).batchRead(['1'], ['name']), /unexpected list shape/);
});

test('the fake answers a batch update with one missing id exactly as HubSpot did live, and the client reads it (live check 2)', async () => {
  const fake = createFakeHubSpot({ token: TOKEN });
  fake.properties.rs_plan = { name: 'rs_plan', type: 'string', fieldType: 'text' };
  const a = fake.addCompany({ name: 'A' });
  const res = await fake.fetch('https://api.hubapi.com/crm/v3/objects/companies/batch/update', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ inputs: [{ id: a.id, properties: { rs_plan: 'Pro' } }, { id: '999', properties: { rs_plan: 'Pro' } }] }) });
  assert.equal(res.status, 207);
  const body = await res.json();
  assert.equal(body.status, 'COMPLETE');
  assert.equal(body.numErrors, 1);
  assert.deepEqual(body.errors, [{ status: 'error', category: 'OBJECT_NOT_FOUND', context: { ids: ['999'] } }]);
  assert.deepEqual(body.results.map((r) => r.id), [a.id]);
  const r = await make(fake).batchUpdate([{ id: a.id, properties: { rs_plan: 'Pro' } }, { id: '999', properties: { rs_plan: 'Pro' } }]);
  assert.deepEqual(r, { ok: [a.id], failed: [{ id: '999', reason: 'OBJECT_NOT_FOUND' }] });
});
