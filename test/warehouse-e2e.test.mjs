import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { validate } from './helpers/schema.mjs';
import { makeWorld } from './helpers/world.mjs';
import { billingFields, rowsFromStripe, toWire } from './helpers/warehouse-rows.mjs';

const BILLING_SQL = 'select * from `demo-project.stripe.revenue_sync_billing`\n';
const USAGE_SQL = 'select account_id, user_id, date, domain from `demo-project.product.activity`\n';
const USAGE_FIELDS = [{ name: 'account_id', type: 'STRING' }, { name: 'user_id', type: 'STRING' }, { name: 'date', type: 'DATE' }, { name: 'domain', type: 'STRING' }];
const company = (w, name) => w.hubspot.companies.find((c) => c.properties.name === name);
const writes = (w) => w.hubspot.requests.filter((r) => r.method === 'POST' && /batch\/update$/.test(r.path));
const noStripe = (w) => ({ env: { ...w.env, STRIPE_API_KEY: undefined } });

// A seeded world whose warehouse holds exactly what Stripe holds, as a correct --billing-sql
// over Stripe Data Pipeline would return it.
async function warehouseWorld({ mutate = (rows) => rows } = {}) {
  const w = makeWorld({ google: true });
  await w.run(main, ['seed', '--hubspot']);
  const fields = billingFields();
  const rows = mutate(rowsFromStripe(w.stripe.db));
  w.bigquery.results.set(BILLING_SQL, { fields, rows: toWire(fields, rows) });
  writeFileSync(join(w.cwd, 'billing.sql'), BILLING_SQL);
  const csv = readFileSync(join(w.cwd, 'usage.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
  w.bigquery.results.set(USAGE_SQL, { fields: USAGE_FIELDS, rows: csv.map(([a, u, d, dom]) => [a, u, d, dom || null]), pageSize: 100 });
  writeFileSync(join(w.cwd, 'usage.sql'), USAGE_SQL);
  return w;
}

test('sync from BigQuery billing writes the same values the Stripe path writes, with no Stripe key', async () => {
  const w = await warehouseWorld();
  const sync = await w.run(main, ['sync', '--billing-sql', 'billing.sql', '--usage', 'usage.csv'], noStripe(w));
  assert.equal(sync.code, 0, sync.err);
  assert.match(sync.out, /Read 11 billing customers, 12 subscriptions, 11 open invoices from BigQuery; 10 HubSpot companies; 9 usage accounts\./);
  assert.equal(w.stripe.requests.filter((r) => r.path !== '/v1/products' && r.method === 'GET' && r.path === '/v1/customers').length, 1, 'only seed read Stripe');
  assert.equal(company(w, 'Northwind Analytics').properties.rs_mrr, '1300');
  assert.equal(company(w, 'Soylent Foods').properties.rs_mrr, '420');
  assert.equal(company(w, 'Initrode Health').properties.rs_mrr, '2166.67');
  assert.equal(company(w, 'Hooli Robotics').properties.rs_billing_status, 'trialing');
  assert.equal(company(w, 'Stark Biotech').properties.rs_mrr ?? null, null, 'mixed currency is flagged on this path too');
  const rec = await w.run(main, ['reconcile', '--billing-sql', 'billing.sql', '--usage', 'usage.csv'], noStripe(w));
  assert.equal(rec.code, 0, rec.out + rec.err);
  assert.match(rec.out, /Stripe was not compared: STRIPE_API_KEY is not set\./);
});

test('usage from BigQuery gives the same usage values as the usage CSV', async () => {
  const w = await warehouseWorld();
  const r = await w.run(main, ['sync', '--billing-sql', 'billing.sql', '--usage-sql', 'usage.sql'], noStripe(w));
  assert.equal(r.code, 0, r.err);
  assert.equal(company(w, 'Northwind Analytics').properties.rs_active_users_30d, '20');
  assert.equal(company(w, 'Northwind Analytics').properties.rs_usage_trend, 'up');
  const csv = await w.run(main, ['reconcile', '--billing-sql', 'billing.sql', '--usage', 'usage.csv'], noStripe(w));
  assert.equal(csv.code, 0, 'the CSV path agrees with what the query path wrote');
});

test('a warehouse run without Google credentials stops before any request', async () => {
  const w = await warehouseWorld();
  const before = w.bigquery.requests.length + w.hubspot.requests.length;
  const r = await w.run(main, ['plan', '--billing-sql', 'billing.sql'], { env: { HUBSPOT_TOKEN: w.env.HUBSPOT_TOKEN } });
  assert.equal(r.code, 1);
  assert.match(r.err, /No Google credentials\. Set GOOGLE_APPLICATION_CREDENTIALS/);
  assert.equal(w.bigquery.requests.length + w.hubspot.requests.length, before);
});

test('flag mistakes stop before any request: --usage with --usage-sql, a BigQuery flag without a query, a missing SQL file', async () => {
  const w = await warehouseWorld();
  for (const [argv, re, extra] of [
    [['plan', '--billing-sql', 'billing.sql', '--usage', 'usage.csv', '--usage-sql', 'usage.sql'], /--usage and --usage-sql cannot both be given/],
    [['plan', '--bigquery-project', 'p'], /--bigquery-project only applies with --billing-sql or --usage-sql/, {}],
    [['plan', '--billing-sql', 'nope.sql'], /The billing SQL file .*nope\.sql does not exist/],
  ]) {
    const r = await w.run(main, argv, extra ?? noStripe(w));
    assert.equal(r.code, 1, argv.join(' '));
    assert.match(r.err, re);
  }
  assert.equal(w.bigquery.requests.length, 0);
});

test('a row that breaks the contract stops the run with exit 1 naming the file, row and column; nothing is written', async () => {
  const w = await warehouseWorld({ mutate: (rows) => { rows.find((r) => r.record === 'item').quantity = null; return rows; } });
  const r = await w.run(main, ['sync', '--billing-sql', 'billing.sql'], noStripe(w));
  assert.equal(r.code, 1);
  assert.match(r.err, /billing\.sql row \d+, column quantity: an item row needs a value/);
  assert.equal(writes(w).length, 0);
});

test('a BigQuery error is exit 2 with the query error shown', async () => {
  const w = await warehouseWorld();
  w.bigquery.results.delete(BILLING_SQL);
  const r = await w.run(main, ['plan', '--billing-sql', 'billing.sql'], noStripe(w));
  assert.equal(r.code, 2);
  assert.match(r.err, /BigQuery refused the query \(400, invalidQuery\)/);
});

test('the warehouse identity guards unlinks: a warehouse sync after a Stripe sync holds a missing company until --allow-unlink, which records the query', async () => {
  const w = await warehouseWorld({ mutate: (rows) => {
    const gone = rows.find((r) => r.record === 'customer' && r.customer_email === 'art@vandelay.example').customer_id;
    const subs = new Set(rows.filter((r) => r.customer_id === gone && r.record === 'subscription').map((r) => r.subscription_id));
    return rows.filter((r) => r.customer_id !== gone && !subs.has(r.subscription_id));
  } });
  assert.equal((await w.run(main, ['sync'])).code, 0);
  const held = await w.run(main, ['sync', '--billing-sql', 'billing.sql'], noStripe(w));
  assert.equal(held.code, 0, held.err);
  const id = `bigquery:demo-project:${createHash('sha256').update(BILLING_SQL).digest('hex').slice(0, 16)}`;
  assert.match(held.out, new RegExp(`Held, not unlinked: Vandelay Imports \\(HubSpot \\d+\\): this run reads billing source ${id}, but this state folder was synced from acct_1FakeSeedAccount`));
  assert.equal(company(w, 'Vandelay Imports').properties.rs_billing_status, 'canceled');
  const allowed = await w.run(main, ['sync', '--billing-sql', 'billing.sql', '--allow-unlink'], noStripe(w));
  assert.equal(allowed.code, 0, allowed.err);
  assert.equal(company(w, 'Vandelay Imports').properties.rs_billing_status, 'unlinked');
  assert.equal(JSON.parse(readFileSync(join(w.cwd, '.revenue-sync', 'synced.json'), 'utf8')).stripe_account, id);
});

test('run.log says the billing came from BigQuery, and the model says which sources ran', async () => {
  const w = await warehouseWorld();
  await w.run(main, ['plan', '--billing-sql', 'billing.sql', '--usage-sql', 'usage.sql'], noStripe(w));
  assert.match(readFileSync(join(w.cwd, '.revenue-sync', 'run.log'), 'utf8'), /plan exit=0 data=real billing=bigquery/);
  const model = JSON.parse(readFileSync(join(w.cwd, '.revenue-sync', 'model.json'), 'utf8'));
  assert.deepEqual(model.sources.billing, { source: 'bigquery' });
  assert.equal(model.sources.usage.source, 'bigquery');
  const schema = JSON.parse(readFileSync(new URL('../schema/account-model.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(validate(schema, model, schema), [], 'the optional source fields are in the published v1 schema');
});

test('a skipped usage query row is reported as a query row, not a CSV line', async () => {
  const w = await warehouseWorld();
  w.bigquery.results.get(USAGE_SQL).rows.push(['northwind', null, '2026-10-01', null]);
  const r = await w.run(main, ['plan', '--billing-sql', 'billing.sql', '--usage-sql', 'usage.sql'], noStripe(w));
  assert.match(r.out, /Skipped usage query row \d+: has no user_id/);
});

function allFiles(dir) {
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? allFiles(join(dir, f)) : [join(dir, f)]));
}

test('no private key or access token in any output or state file, even when an error echoes them', async () => {
  const w = await warehouseWorld();
  const key = JSON.parse(w.env.GOOGLE_SERVICE_ACCOUNT_JSON).private_key;
  const echo = () => { throw new TypeError(`connect failed ${[...w.bigquery.tokens].join(' ')} ${key}`); };
  w.bigquery.failures['POST /bigquery/v2/projects/demo-project/queries'] = Array.from({ length: 6 }, () => echo);
  const failed = await w.run(main, ['plan', '--billing-sql', 'billing.sql'], noStripe(w));
  assert.equal(failed.code, 2);
  const unexpected = await w.run(main, ['plan', '--billing-sql', 'billing.sql'], { ...noStripe(w), fetch: async () => { throw Object.assign(new Error(`boom ${key} ya29.leaked-token-123`), { code: 'EWEIRD' }); }, sleep: async () => {} });
  const runs = [failed, unexpected, await w.run(main, ['sync', '--billing-sql', 'billing.sql'], noStripe(w))];
  assert.equal(runs[2].code, 0, runs[2].err);
  for (const t of [...runs.flatMap((r) => [r.out, r.err]), ...allFiles(w.cwd).map((f) => readFileSync(f, 'utf8'))]) {
    assert.ok(!t.includes('PRIVATE KEY'), 'private key leaked');
    for (const tok of [...w.bigquery.tokens, 'ya29.leaked-token-123']) assert.ok(!t.includes(tok), 'access token leaked');
  }
});

test('cross-source: with STRIPE_API_KEY set, reconcile also compares warehouse MRR with Stripe; identical data passes', async () => {
  const w = await warehouseWorld();
  assert.equal((await w.run(main, ['sync', '--billing-sql', 'billing.sql', '--usage', 'usage.csv'], noStripe(w))).code, 0);
  const rec = await w.run(main, ['reconcile', '--billing-sql', 'billing.sql', '--usage', 'usage.csv']);
  assert.equal(rec.code, 0, rec.out + rec.err);
  assert.match(rec.out, /Warehouse and Stripe agree on MRR: 7 of 8 companies compared\./);
  assert.match(rec.out, /Not compared: Stark Biotech \(HubSpot \d+\): flagged in the warehouse: /);
});

test('cross-source: a warehouse behind Stripe fails reconcile (exit 3) naming the company and both values, even when HubSpot agrees with the warehouse', async () => {
  const w = await warehouseWorld({ mutate: (rows) => {
    const nw = rows.find((r) => r.record === 'customer' && r.customer_email === 'ap@northwind.example').customer_id;
    const sub = rows.find((r) => r.record === 'subscription' && r.customer_id === nw).subscription_id;
    rows.find((r) => r.record === 'item' && r.subscription_id === sub).quantity = 30;
    return rows;
  } });
  assert.equal((await w.run(main, ['sync', '--billing-sql', 'billing.sql', '--usage', 'usage.csv'], noStripe(w))).code, 0);
  const hubspotOnly = await w.run(main, ['reconcile', '--billing-sql', 'billing.sql', '--usage', 'usage.csv'], noStripe(w));
  assert.equal(hubspotOnly.code, 0, 'HubSpot matches the warehouse');
  const rec = await w.run(main, ['reconcile', '--billing-sql', 'billing.sql', '--usage', 'usage.csv']);
  assert.equal(rec.code, 3, rec.out + rec.err);
  assert.match(rec.out, /Warehouse and Stripe disagree on MRR for 1 company\.\n\nNorthwind Analytics \(HubSpot \d+\): warehouse says 1560 USD, Stripe says 1300 USD/);
  assert.match(rec.out, /Checked values agree: 8 companies/, 'the HubSpot comparison is reported separately');
});

test('cross-source: a malformed STRIPE_API_KEY next to --billing-sql stops reconcile before any request', async () => {
  const w = await warehouseWorld();
  const before = w.bigquery.requests.length;
  const r = await w.run(main, ['reconcile', '--billing-sql', 'billing.sql'], { env: { ...w.env, STRIPE_API_KEY: 'pk_test_123' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /STRIPE_API_KEY does not look like/);
  assert.equal(w.bigquery.requests.length, before);
});

// A usage source given as --usage-sql counts as a usage source everywhere.
function churnNorthwind(w) {
  const cus = w.stripe.db.customers.find((c) => c.name === 'Northwind Analytics').id;
  const subs = new Set(w.stripe.db.subscriptions.filter((s) => s.customer === cus).map((s) => s.id));
  const fields = billingFields();
  w.bigquery.results.set(BILLING_SQL, { fields, rows: toWire(fields, rowsFromStripe(w.stripe.db).filter((r) => r.customer_id !== cus && !subs.has(r.subscription_id))) });
  const u = w.bigquery.results.get(USAGE_SQL);
  w.bigquery.results.set(USAGE_SQL, { ...u, rows: u.rows.filter((r) => r[3] !== 'northwind.example') });
}

test('B1: a company that churns from warehouse billing and warehouse usage is unlinked on the warehouse quickstart command, not held forever', async () => {
  const w = await warehouseWorld();
  const args = ['--billing-sql', 'billing.sql', '--usage-sql', 'usage.sql'];
  assert.equal((await w.run(main, ['sync', ...args], noStripe(w))).code, 0);
  churnNorthwind(w);
  const s = await w.run(main, ['sync', ...args], noStripe(w));
  assert.equal(s.code, 0, s.err);
  assert.doesNotMatch(s.out, /Held, not unlinked: Northwind/);
  assert.equal(company(w, 'Northwind Analytics').properties.rs_billing_status, 'unlinked');
  assert.equal(company(w, 'Northwind Analytics').properties.rs_mrr ?? '', '');
  const rec = await w.run(main, ['reconcile', ...args], noStripe(w));
  assert.equal(rec.code, 0, rec.out);
  assert.match(rec.out, /Unlinked, values cleared: Northwind Analytics/);
});

test('B1: a run with no usage source holds a usage-linked company and names both usage flags', async () => {
  const w = await warehouseWorld();
  assert.equal((await w.run(main, ['sync', '--billing-sql', 'billing.sql', '--usage-sql', 'usage.sql'], noStripe(w))).code, 0);
  churnNorthwind(w);
  const s = await w.run(main, ['sync', '--billing-sql', 'billing.sql'], noStripe(w));
  assert.match(s.out, /Held, not unlinked: Northwind Analytics \(HubSpot \d+\): it was linked by usage and this run has no usage source \(--usage or --usage-sql\)/);
  const rec = await w.run(main, ['reconcile', '--billing-sql', 'billing.sql'], noStripe(w));
  assert.match(rec.out, /Usage values were not checked: no usage source was given \(--usage or --usage-sql\)\./);
});

test('B2: the P1 repro, a duplicated Northwind discount row, stops sync with exit 1 instead of writing 1040', async () => {
  const w = await warehouseWorld({ mutate: (rows) => [...rows, { ...rows.find((r) => r.record === 'discount' && r.percent_off === '20') }] });
  const r = await w.run(main, ['sync', '--billing-sql', 'billing.sql', '--usage', 'usage.csv'], noStripe(w));
  assert.equal(r.code, 1);
  assert.match(r.err, /column discount_id: di_\w+ appears twice/);
  assert.equal(company(w, 'Northwind Analytics').properties.rs_mrr ?? null, null);
});

// ---- I2: the demo's cross-source claim is tested, not asserted ----
import { demoBillingRows } from './helpers/demo-sql.mjs';

const DEMO = readFileSync(new URL('../examples/bigquery/demo-billing.sql', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-07T09:00:00Z');

async function demoWorld(mutate = (rows) => rows) {
  const w = makeWorld({ google: true });
  await w.run(main, ['seed', '--hubspot']);
  const { fields, rows } = demoBillingRows(DEMO, NOW);
  w.bigquery.results.set(DEMO, { fields, rows: toWire(fields, mutate(rows)) });
  writeFileSync(join(w.cwd, 'demo-billing.sql'), DEMO);
  return w;
}

test('I2: on the day of seed, the demo billing query and the seeded Stripe account agree on MRR for every company, so the cross-source check passes', async () => {
  const w = await demoWorld();
  const sync = await w.run(main, ['sync', '--billing-sql', 'demo-billing.sql', '--usage', 'usage.csv'], noStripe(w));
  assert.equal(sync.code, 0, sync.err);
  assert.equal(company(w, 'Northwind Analytics').properties.rs_mrr, '1300');
  assert.equal(company(w, 'Soylent Foods').properties.rs_mrr, '420');
  const rec = await w.run(main, ['reconcile', '--billing-sql', 'demo-billing.sql', '--usage', 'usage.csv']);
  assert.equal(rec.code, 0, rec.out + rec.err);
  assert.match(rec.out, /Warehouse and Stripe agree on MRR: 7 of 8 companies compared\./);
});

test('I2: the README\'s instruction, Northwind at 30 seats in the demo, fails the cross-source check with 1560 against 1300', async () => {
  const w = await demoWorld((rows) => rows.map((r) => (r.item_id === 'si_demo_1' ? { ...r, quantity: '30' } : r)));
  await w.run(main, ['sync', '--billing-sql', 'demo-billing.sql', '--usage', 'usage.csv'], noStripe(w));
  const rec = await w.run(main, ['reconcile', '--billing-sql', 'demo-billing.sql', '--usage', 'usage.csv']);
  assert.equal(rec.code, 3);
  assert.match(rec.out, /Northwind Analytics \(HubSpot \d+\): warehouse says 1560 USD, Stripe says 1300 USD/);
});

test('I2: the demo has no hard-coded dates; every timestamp is relative to the day it runs, as seed\'s are', () => {
  assert.doesNotMatch(DEMO, /TIMESTAMP '\d{4}-/);
  assert.match(DEMO, /Run within 14\s+(--\s+)?days of `seed --hubspot`/);
});

test('m2: run.log says whether the cross-source check ran and how it came out, and marks the demo as demo data', async () => {
  const w = await demoWorld();
  await w.run(main, ['sync', '--billing-sql', 'demo-billing.sql', '--usage', 'usage.csv'], noStripe(w));
  await w.run(main, ['reconcile', '--billing-sql', 'demo-billing.sql', '--usage', 'usage.csv']);
  await w.run(main, ['reconcile', '--billing-sql', 'demo-billing.sql', '--usage', 'usage.csv'], noStripe(w));
  const log = readFileSync(join(w.cwd, '.revenue-sync', 'run.log'), 'utf8').trim().split('\n');
  assert.match(log.at(-3), / sync exit=0 data=demo billing=bigquery( |$)/);
  assert.match(log.at(-2), / reconcile exit=0 data=demo billing=bigquery cross=pass( |$)/);
  assert.match(log.at(-1), / reconcile exit=0 data=demo billing=bigquery cross=skipped( |$)/);
  const bad = await demoWorld((rows) => rows.map((r) => (r.item_id === 'si_demo_1' ? { ...r, quantity: '30' } : r)));
  await bad.run(main, ['reconcile', '--billing-sql', 'demo-billing.sql', '--usage', 'usage.csv']);
  assert.match(readFileSync(join(bad.cwd, '.revenue-sync', 'run.log'), 'utf8'), / reconcile exit=3 data=demo billing=bigquery cross=fail( |$)/m);
});
