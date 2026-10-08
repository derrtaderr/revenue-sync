import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHubSpotClient } from '../src/hubspot.mjs';
import { ensureProperties, runSync, readCurrent } from '../src/sync.mjs';
import { DEFINITIONS, PROPERTY_GROUP } from '../src/definitions.mjs';
import { readJson } from '../src/store.mjs';
import { openJournal } from '../src/journal.mjs';
import { createFakeHubSpot } from './helpers/fake-hubspot.mjs';
import { hubspotToken } from './helpers/keys.mjs';

const TOKEN = hubspotToken();
const tmp = () => mkdtempSync(join(tmpdir(), 'rs-sync-'));
const client = (fake) => createHubSpotClient({ token: TOKEN, fetch: fake.fetch, sleep: async () => {}, random: () => 0 });
const metrics = (mrr) => ({ mrr, arr: mrr * 12, currency: 'USD', outstanding_amount: 0, plan: 'Pro', billing_status: 'active', renewal_date: '2026-11-01', seat_count: 3, active_users_30d: 7, usage_trend: 'up' });

function world(n = 2) {
  const fake = createFakeHubSpot({ token: TOKEN });
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const c = fake.addCompany({ name: `Co ${i}`, domain: `co${i}.example` });
    accounts.push({ hubspot_company_id: c.id, hubspot_company_name: `Co ${i}`, metrics: metrics(100 + i), blocked: [], flags: [] });
  }
  return { fake, hs: client(fake), model: { accounts }, dir: tmp() };
}

async function sync(w) {
  const current = await readCurrent(w.hs);
  return runSync({ hubspot: w.hs, model: w.model, current, dir: w.dir, runId: `run-${Math.random()}` });
}

const updates = (fake) => fake.requests.filter((r) => r.path.endsWith('/batch/update'));

test('the first sync creates the property group and every property; later syncs create nothing', async () => {
  const w = world();
  const first = await ensureProperties(w.hs, { create: true });
  assert.equal(first.missing.length, DEFINITIONS.length);
  assert.equal(first.missingGroup, true);
  assert.equal(w.fake.groups[PROPERTY_GROUP.name].label, 'Revenue sync');
  for (const d of DEFINITIONS) assert.equal(w.fake.properties[d.property].groupName, 'revenue_sync');
  const again = await ensureProperties(w.hs, { create: true });
  assert.deepEqual(again.missing, []);
});

test('without create, missing properties are only reported', async () => {
  const w = world();
  const r = await ensureProperties(w.hs, { create: false });
  assert.equal(r.missing.length, DEFINITIONS.length);
  assert.equal(w.fake.properties.rs_mrr, undefined);
  assert.equal(w.fake.requests.filter((x) => x.method === 'POST').length, 0);
});

test('sync writes every planned value; a second sync writes nothing', async () => {
  const w = world();
  await ensureProperties(w.hs, { create: true });
  const r = await sync(w);
  assert.equal(r.written, 20);
  assert.equal(w.fake.companies[0].properties.rs_mrr, '100');
  assert.equal(w.fake.companies[1].properties.rs_renewal_date, '2026-11-01');
  const before = updates(w.fake).length;
  const again = await sync(w);
  assert.equal(again.written, 0);
  assert.equal(updates(w.fake).length, before, 'no batch request at all');
});

test('the synced snapshot records what HubSpot now holds', async () => {
  const w = world(1);
  await ensureProperties(w.hs, { create: true });
  await sync(w);
  const snap = readJson(join(w.dir, 'synced.json'));
  assert.equal(snap.values[w.model.accounts[0].hubspot_company_id].rs_mrr, '100');
});

test('writes go in batches of at most 100 companies', async () => {
  const w = world(150);
  await ensureProperties(w.hs, { create: true });
  await sync(w);
  assert.deepEqual(updates(w.fake).map((r) => r.body.inputs.length), [100, 50]);
});

test('a rate-limited batch is retried and lands once', async () => {
  const w = world();
  await ensureProperties(w.hs, { create: true });
  w.fake.failures['POST /crm/v3/objects/companies/batch/update'] = [429, 503];
  const r = await sync(w);
  assert.equal(r.written, 20);
  assert.equal(w.fake.companies[1].properties.rs_mrr, '101');
});

test('companies HubSpot rejects are reported with the reason and kept out of the snapshot', async () => {
  const w = world();
  await ensureProperties(w.hs, { create: true });
  const current = await readCurrent(w.hs);
  w.fake.companies.splice(1, 1);
  const r = await runSync({ hubspot: w.hs, model: w.model, current, dir: w.dir, runId: 'r' });
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].company_name, 'Co 1');
  assert.match(r.rejected[0].reason, /OBJECT_NOT_FOUND/);
  const snap = readJson(join(w.dir, 'synced.json'));
  assert.ok(!(w.model.accounts[1].hubspot_company_id in snap.values));
});

test('a crash after a batch landed but before it was journaled resumes without writing it twice', async () => {
  const w = world(150);
  await ensureProperties(w.hs, { create: true });
  let calls = 0;
  w.fake.failures['POST /crm/v3/objects/companies/batch/update'] = [
    undefined,
    async (real) => { await real(); throw new TypeError('socket hang up'); },
    ...Array.from({ length: 5 }, () => async () => { throw new TypeError('network down'); }),
  ];
  w.fake.failures['POST /crm/v3/objects/companies/batch/update'][0] = async (real) => { calls++; return real(); };
  await assert.rejects(sync(w), /Could not reach HubSpot/);
  const pending = openJournal(w.dir).unfinished();
  assert.deepEqual([...pending.done], [1]);
  assert.equal(w.fake.companies[149].properties.rs_mrr, '249', 'batch 2 did land');

  const before = updates(w.fake).length;
  const r = await sync(w);
  assert.equal(r.resumed, pending.run);
  assert.equal(r.written, 0, 'nothing written twice');
  assert.equal(updates(w.fake).length, before, 'batch 1 skipped from the journal, batch 2 re-read and found already applied');
  assert.equal(openJournal(w.dir).unfinished(), null);
  assert.equal(calls, 1);
});

test('a crash before a batch landed resumes by sending exactly that batch', async () => {
  const w = world(150);
  await ensureProperties(w.hs, { create: true });
  w.fake.failures['POST /crm/v3/objects/companies/batch/update'] = [undefined, ...Array.from({ length: 6 }, () => async () => { throw new TypeError('network down'); })];
  w.fake.failures['POST /crm/v3/objects/companies/batch/update'][0] = (real) => real();
  await assert.rejects(sync(w), /Could not reach HubSpot/);
  assert.equal(w.fake.companies[149].properties.rs_mrr ?? null, null);
  const before = updates(w.fake).length;
  const r = await sync(w);
  assert.equal(r.written, 50 * 10);
  assert.deepEqual(updates(w.fake).slice(before).map((x) => x.body.inputs.length), [50]);
  assert.equal(w.fake.companies[149].properties.rs_mrr, '249');
});

function strictWorld(n) {
  const fake = createFakeHubSpot({ token: TOKEN, wholeBatchNotFound: true });
  const accounts = [];
  for (let i = 0; i < n; i++) {
    const c = fake.addCompany({ name: `Co ${i}`, domain: `co${i}.example` });
    accounts.push({ hubspot_company_id: c.id, hubspot_company_name: `Co ${i}`, metrics: metrics(100 + i), blocked: [], flags: [] });
  }
  return { fake, hs: client(fake), model: { accounts }, dir: tmp() };
}

test('a whole batch refused because one company was deleted is retried without it, and the rest land (I2)', async () => {
  const w = strictWorld(3);
  await ensureProperties(w.hs, { create: true });
  const current = await readCurrent(w.hs);
  w.fake.companies.splice(1, 1);
  const r = await runSync({ hubspot: w.hs, model: w.model, current, dir: w.dir, runId: 'r' });
  assert.equal(r.rejected.length, 1);
  assert.equal(r.rejected[0].company_name, 'Co 1');
  assert.match(r.rejected[0].reason, /deleted or merged in HubSpot/);
  assert.equal(w.fake.companies[1].properties.rs_mrr, '102');
  assert.equal(openJournal(w.dir).unfinished(), null);
});

test('resuming a run whose batch names a company deleted since the crash drops it and finishes (I2)', async () => {
  const w = strictWorld(3);
  await ensureProperties(w.hs, { create: true });
  w.fake.failures['POST /crm/v3/objects/companies/batch/update'] = Array.from({ length: 6 }, () => 503);
  await assert.rejects(sync(w), /kept failing/);
  assert.ok(openJournal(w.dir).unfinished());
  w.fake.companies.splice(1, 1);
  const r = await sync(w);
  assert.ok(r.resumed);
  assert.equal(r.rejected[0].company_name, 'Co 1');
  assert.equal(w.fake.companies[1].properties.rs_mrr, '102');
  assert.equal(openJournal(w.dir).unfinished(), null, 'the run completes instead of failing forever');
});

test('a batch HubSpot keeps refusing stops with the recovery step named', async () => {
  const w = strictWorld(2);
  await ensureProperties(w.hs, { create: true });
  w.fake.failures['POST /crm/v3/objects/companies/batch/update'] = [400, 400];
  await assert.rejects(sync(w), /delete .*journal\.jsonl/);
});
