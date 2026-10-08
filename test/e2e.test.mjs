import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { makeWorld } from './helpers/world.mjs';

const writes = (w) => w.hubspot.requests.filter((r) => r.method === 'POST' && /batch\/update$/.test(r.path));
const company = (w, name) => w.hubspot.companies.find((c) => c.properties.name === name);

test('quickstart: seed, plan, sync, reconcile exits 0; a re-run writes nothing', async () => {
  const w = makeWorld();
  const seed = await w.run(main, ['seed', '--hubspot']);
  assert.equal(seed.code, 0, seed.err);

  const plan = await w.run(main, ['plan', '--usage', 'usage.csv']);
  assert.equal(plan.code, 0, plan.err);
  assert.equal(writes(w).length, 0);
  assert.match(plan.out, /Matched 8 companies\. Refused: 2 unmatched, 2 ambiguous\. Flagged: 1\./);
  assert.match(plan.out, /Northwind Analytics \(HubSpot \d+\)\n {2}rs_mrr: \(empty\) → 1300/);
  assert.match(plan.out, /Ambiguous, not written: stripe cus_\w+ \(Massive Dynamic\): matches Massive Dynamic \(\d+\) and Massive Dynamic \(old record\) \(\d+\)/);
  assert.match(plan.out, /Unmatched, not written: stripe cus_\w+ \(Pied Piper\): gmail\.com is a free mail domain/);
  assert.match(plan.out, /Flagged, money values not written: Stark Biotech/);

  const sync = await w.run(main, ['sync', '--usage', 'usage.csv']);
  assert.equal(sync.code, 0, sync.err);
  assert.match(sync.out, /Created the property group revenue_sync and 10 properties/);
  assert.match(sync.out, /Wrote \d+ values to HubSpot\./);

  const nw = company(w, 'Northwind Analytics').properties;
  assert.equal(nw.rs_mrr, '1300', '25 seats at $65 less 20 percent');
  assert.equal(nw.rs_arr, '15600');
  assert.equal(nw.rs_usage_trend, 'up');
  assert.equal(company(w, 'Globex Logistics').properties.rs_mrr, '2000', '$24,000 a year');
  assert.equal(company(w, 'Hooli Robotics').properties.rs_billing_status, 'trialing');
  assert.equal(company(w, 'Vandelay Imports').properties.rs_billing_status, 'canceled');
  assert.equal(company(w, 'Umbrella Freight').properties.rs_mrr, '1140', 'two subscriptions on one customer');
  assert.equal(company(w, 'Soylent Foods').properties.rs_mrr, '420', '8 seats at $65 less $100 a month');
  assert.equal(company(w, 'Stark Biotech').properties.rs_mrr ?? null, null, 'mixed currency is never written');
  // Verified live 2026-10-07: each of these matched an independent recomputation from raw Stripe data.
  assert.equal(company(w, 'Initrode Health').properties.rs_mrr, '2166.67', '40 seats at $650 a year, over 12');
  assert.equal(company(w, 'Vandelay Imports').properties.rs_mrr, '0', 'canceled');
  assert.equal(company(w, 'Hooli Robotics').properties.rs_mrr, '0', 'trialing counts as zero');

  const rec = await w.run(main, ['reconcile', '--usage', 'usage.csv']);
  assert.equal(rec.code, 0, rec.out + rec.err);
  assert.match(rec.out, /Checked values agree: 8 companies, \d+ values\. Not checked: 1 flagged company, 2 unmatched records, 2 ambiguous records\. Exit 0; --strict makes these fail\./);
  assert.doesNotMatch(rec.out, /HubSpot agrees/, 'the seed data has refused and flagged records on purpose');

  const before = writes(w).length;
  const again = await w.run(main, ['sync', '--usage', 'usage.csv']);
  assert.equal(again.code, 0);
  assert.match(again.out, /Nothing to write/);
  assert.equal(writes(w).length, before);

  const strict = await w.run(main, ['reconcile', '--usage', 'usage.csv', '--strict']);
  assert.equal(strict.code, 3, 'strict fails on the refused and flagged records seed creates on purpose');
});

test('reconcile fails when someone edits a value in HubSpot, names it, and sync puts it back', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync', '--usage', 'usage.csv']);
  const nw = company(w, 'Northwind Analytics');
  nw.properties.rs_mrr = '1500';
  nw.properties.rs_seat_count = '30';

  const rec = await w.run(main, ['reconcile', '--usage', 'usage.csv']);
  assert.equal(rec.code, 3);
  assert.match(rec.out, new RegExp(`Northwind Analytics \\(HubSpot ${nw.id}\\)\\n {2}MRR \\(rs_mrr\\): HubSpot says 1500, billing says 1300\\n {2}Seats \\(rs_seat_count\\): HubSpot says 30, billing says 25`));

  const plan = await w.run(main, ['plan', '--usage', 'usage.csv']);
  assert.match(plan.out, /rs_mrr: 1500 → 1300 \(edited in HubSpot since the last sync\)/);

  await w.run(main, ['sync', '--usage', 'usage.csv']);
  assert.equal(nw.properties.rs_mrr, '1300');
  assert.equal((await w.run(main, ['reconcile', '--usage', 'usage.csv'])).code, 0);
});

test('reconcile fails when billing changes and nobody synced', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync', '--usage', 'usage.csv']);
  const sub = w.stripe.db.subscriptions.find((s) => w.stripe.db.customers.find((c) => c.id === s.customer).name === 'Globex Logistics');
  sub.status = 'past_due';
  const rec = await w.run(main, ['reconcile', '--usage', 'usage.csv']);
  assert.equal(rec.code, 3);
  assert.match(rec.out, /Billing status \(rs_billing_status\): HubSpot says active, billing says past_due/);
});

test('a mapping row settles the ambiguous company and the free mail customer', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const massive = w.hubspot.companies.find((c) => c.properties.name === 'Massive Dynamic');
  const pied = w.stripe.db.customers.find((c) => c.name === 'Pied Piper');
  const massiveCus = w.stripe.db.customers.find((c) => c.name === 'Massive Dynamic');
  writeFileSync(join(w.cwd, 'mapping.csv'), `source,source_id,hubspot_company_id\nstripe,${massiveCus.id},${massive.id}\nusage,massive,${massive.id}\nstripe,${pied.id},${company(w, 'Hooli Robotics').id}\n`);
  const plan = await w.run(main, ['plan', '--usage', 'usage.csv', '--mapping', 'mapping.csv']);
  assert.match(plan.out, /Matched 9 companies\. Refused: 1 unmatched, 0 ambiguous\./);
  const model = JSON.parse(readFileSync(join(w.cwd, '.revenue-sync', 'model.json'), 'utf8'));
  const m = model.accounts.find((a) => a.hubspot_company_id === massive.id);
  assert.equal(m.matched_by[massiveCus.id], 'mapping');
});

test('an interrupted sync resumes on the next run without writing a batch twice', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  w.hubspot.failures['POST /crm/v3/objects/companies/batch/update'] = [
    async (real) => { await real(); throw new TypeError('socket hang up'); },
    ...Array.from({ length: 5 }, () => async () => { throw new TypeError('network down'); }),
  ];
  const crashed = await w.run(main, ['sync', '--usage', 'usage.csv']);
  assert.equal(crashed.code, 2);
  assert.match(crashed.err, /next sync resumes it without writing anything twice/);
  const before = writes(w).length;
  const resumed = await w.run(main, ['sync', '--usage', 'usage.csv']);
  assert.equal(resumed.code, 0, resumed.err);
  assert.match(resumed.out, /Resumed an interrupted sync/);
  assert.equal(writes(w).length, before, 'the batch had landed, so nothing was re-sent');
  assert.equal((await w.run(main, ['reconcile', '--usage', 'usage.csv'])).code, 0);
});

test('a product-restricted coupon is priced from the coupons list end to end (B2)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const db = w.stripe.db;
  const nwCus = db.customers.find((c) => c.name === 'Northwind Analytics');
  const nwSub = db.subscriptions.find((s) => s.customer === nwCus.id);
  const coupon = db.coupons.find((c) => c.id === 'RS_SEED_PARTNER20');
  coupon.applies_to = { products: ['prod_not_on_this_subscription'] };
  await w.run(main, ['sync', '--usage', 'usage.csv']);
  assert.equal(company(w, 'Northwind Analytics').properties.rs_mrr, '1625', 'the 20 percent coupon applies to another product, so 25 seats at $65 are undiscounted');
  assert.ok(nwSub.discounts.length);
});

test('a later sync without --usage leaves the usage properties as they were (I4)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync', '--usage', 'usage.csv']);
  const nw = company(w, 'Northwind Analytics').properties;
  assert.equal(nw.rs_usage_trend, 'up');
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 0);
  assert.equal(nw.rs_usage_trend, 'up');
  assert.equal(nw.rs_active_users_30d, '20');
});

// B1: every way a synced company can drop out of the model.
const triggers = {
  'Stripe customer deleted': (w) => {
    const c = w.stripe.db.customers.find((x) => x.name === 'Globex Logistics');
    w.stripe.db.customers.splice(w.stripe.db.customers.indexOf(c), 1);
    for (const s of w.stripe.db.subscriptions) if (s.customer === c.id) s.status = 'canceled';
    w.usage = w.usage.replace(/^globex,.*\n/gm, '');
  },
  'customer email moved to a new domain': (w) => {
    w.stripe.db.customers.find((x) => x.name === 'Globex Logistics').email = 'finance@globex-new.example';
    w.usage = w.usage.replace(/^globex,.*\n/gm, '');
  },
  'HubSpot duplicate created (domain becomes ambiguous)': (w) => {
    w.hubspot.addCompany({ name: 'Globex (dupe)', domain: 'globex.example' });
  },
  'mapping file now sends it to two companies': (w) => {
    const c = w.stripe.db.customers.find((x) => x.name === 'Globex Logistics');
    const ids = w.hubspot.companies.filter((x) => ['Globex Logistics', 'Hooli Robotics'].includes(x.properties.name)).map((x) => x.id);
    w.mapping = `source,source_id,hubspot_company_id\nstripe,${c.id},${ids[0]}\nstripe,${c.id},${ids[1]}\nusage,globex,${ids[0]}\nusage,globex,${ids[1]}\n`;
  },
};

for (const [name, apply] of Object.entries(triggers)) {
  test(`a company that drops out of the model is caught by reconcile and cleared by sync: ${name} (B1)`, async () => {
    const w = makeWorld();
    await w.run(main, ['seed', '--hubspot']);
    w.usage = readFileSync(join(w.cwd, 'usage.csv'), 'utf8');
    w.mapping = 'source,source_id,hubspot_company_id\n';
    await w.run(main, ['sync', '--usage', 'usage.csv']);
    const g = company(w, 'Globex Logistics');
    assert.equal(g.properties.rs_mrr, '2000');
    apply(w);
    writeFileSync(join(w.cwd, 'usage.csv'), w.usage);
    writeFileSync(join(w.cwd, 'mapping.csv'), w.mapping);
    const args = ['--usage', 'usage.csv', '--mapping', 'mapping.csv'];
    const rec = await w.run(main, ['reconcile', ...args]);
    assert.equal(rec.code, 3, rec.out);
    assert.match(rec.out, new RegExp(`Globex Logistics \\(HubSpot ${g.id}\\), no longer linked: [^\\n]+\\n {2}MRR \\(rs_mrr\\): HubSpot says 2000, billing says \\(empty\\)`));
    const plan = await w.run(main, ['plan', ...args]);
    assert.match(plan.out, /Unlinked: Globex Logistics/);
    await w.run(main, ['sync', ...args]);
    assert.equal(g.properties.rs_mrr, '');
    assert.equal(g.properties.rs_billing_status, 'unlinked');
    const after = await w.run(main, ['reconcile', ...args]);
    assert.equal(after.code, 0, after.out);
    assert.match(after.out, /Unlinked, values cleared: Globex Logistics/);
    assert.equal((await w.run(main, ['reconcile', ...args, '--strict'])).code, 3);
  });
}

test('a company unlinked because its mapping row was removed is caught too (B1)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const pp = w.hubspot.addCompany({ name: 'Pied Piper', domain: 'piedpiper.example' });
  const cus = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
  writeFileSync(join(w.cwd, 'mapping.csv'), `source,source_id,hubspot_company_id\nstripe,${cus.id},${pp.id}\n`);
  await w.run(main, ['sync', '--usage', 'usage.csv', '--mapping', 'mapping.csv']);
  assert.equal(pp.properties.rs_mrr, '490');
  writeFileSync(join(w.cwd, 'mapping.csv'), 'source,source_id,hubspot_company_id\n');
  const rec = await w.run(main, ['reconcile', '--usage', 'usage.csv', '--mapping', 'mapping.csv']);
  assert.equal(rec.code, 3);
  assert.match(rec.out, /Pied Piper \(HubSpot \d+\), no longer linked/);
});

// B4: the unlink path is guarded. One run that sees fewer links must not wipe paying customers.
test('a company linked by a mapping row is untouched by a later sync without --mapping (B4.1)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const pp = w.hubspot.addCompany({ name: 'Pied Piper', domain: 'piedpiper.example' });
  const cus = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
  writeFileSync(join(w.cwd, 'map.csv'), `source,source_id,hubspot_company_id\nstripe,${cus.id},${pp.id}\n`);
  await w.run(main, ['sync', '--mapping', 'map.csv']);
  assert.equal(pp.properties.rs_mrr, '490');
  const plan = await w.run(main, ['plan']);
  assert.match(plan.out, /Held, not unlinked: Pied Piper \(HubSpot \d+\): it was linked by a mapping row and this run has no --mapping/);
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 1, 'a sync without the mapping file it was synced with refuses before fetching (F3)');
  assert.equal(pp.properties.rs_mrr, '490');
  assert.equal(pp.properties.rs_billing_status, 'active');
  const rec = await w.run(main, ['reconcile']);
  assert.equal(rec.code, 0, rec.out);
  assert.match(rec.out, /Not checked: [^\n]*1 held company/);
});

test('a usage-only company does not flap on a sync without --usage (B4.1, m8)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const uo = w.hubspot.addCompany({ name: 'Usage Only Co', domain: 'usageonly.example' });
  writeFileSync(join(w.cwd, 'u.csv'), 'account_id,user_id,date,domain\nuo,u1,2026-10-01,usageonly.example\n');
  await w.run(main, ['sync', '--usage', 'u.csv']);
  const before = { ...uo.properties };
  assert.equal(before.rs_billing_status, 'none');
  for (let i = 0; i < 2; i++) {
    assert.equal((await w.run(main, ['sync'])).code, 0);
    assert.deepEqual(uo.properties, before);
  }
});

test('Stripe returning no customers while companies are linked is refused, nothing written, until --allow-unlink (B4.4)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync']);
  w.stripe.db.customers.length = 0;
  const plan = await w.run(main, ['plan']);
  assert.equal(plan.code, 0);
  assert.match(plan.out, /Unlink guard: sync will refuse: Stripe returned no customers, but 8 companies are linked/);
  assert.doesNotMatch(plan.out, /sync clears its revenue-sync values/, 'a refused unlink is not announced as happening');
  assert.match(plan.out, /Unlinked: Globex Logistics[^\n]*cleared only if sync is run with --allow-unlink/);
  const before = writes(w).length;
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 5);
  assert.match(r.err, /Refused to unlink: Stripe returned no customers, but 8 companies are linked\. Nothing was written/);
  assert.match(r.err, /--allow-unlink/);
  assert.equal(writes(w).length, before);
  assert.equal(company(w, 'Globex Logistics').properties.rs_mrr, '2000');
  const forced = await w.run(main, ['sync', '--allow-unlink']);
  assert.equal(forced.code, 0, forced.err);
  assert.equal(company(w, 'Globex Logistics').properties.rs_billing_status, 'unlinked');
});

test('a 200 with no list on /v1/customers stops the run and unlinks nothing (B4.2)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync']);
  w.stripe.failures['GET /v1/customers'] = [() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })];
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 2);
  assert.match(r.err, /unexpected list shape/);
  assert.equal(w.hubspot.companies.filter((c) => c.properties.rs_billing_status === 'unlinked').length, 0);
});

test('a run against a different Stripe account unlinks nothing and says why (B4.3)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync']);
  w.stripe.account.id = 'acct_2OtherAccount';
  const g = w.stripe.db.customers.find((x) => x.name === 'Globex Logistics');
  w.stripe.db.customers.splice(w.stripe.db.customers.indexOf(g), 1);
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Held, not unlinked: Globex Logistics \(HubSpot \d+\): this run reads Stripe account acct_2OtherAccount, but this state folder was synced from acct_1FakeSeedAccount/);
  assert.equal(company(w, 'Globex Logistics').properties.rs_mrr, '2000');
});

test('a key that cannot read the Stripe account unlinks nothing without --allow-unlink (B4.3)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync']);
  w.stripe.account.forbidden = true;
  const g = w.stripe.db.customers.find((x) => x.name === 'Globex Logistics');
  w.stripe.db.customers.splice(w.stripe.db.customers.indexOf(g), 1);
  const r = await w.run(main, ['sync']);
  assert.match(r.out, /Held, not unlinked: Globex Logistics[^\n]*could not be identified \(the key may not read the Stripe account \(403\)\)/);
  assert.equal(company(w, 'Globex Logistics').properties.rs_mrr, '2000');
  await w.run(main, ['sync', '--allow-unlink']);
  assert.equal(company(w, 'Globex Logistics').properties.rs_billing_status, 'unlinked');
});

test('a Stripe that lists unrestricted coupons as applies_to {products: []} still discounts everything (I9)', async () => {
  const w = makeWorld({ stripeOptions: { emptyAppliesTo: true } });
  await w.run(main, ['seed', '--hubspot']);
  const listed = await w.fetch('https://api.stripe.com/v1/coupons?expand%5B%5D=data.applies_to', { headers: { authorization: `Bearer ${w.env.STRIPE_API_KEY}`, 'stripe-version': '2026-09-30.endive' } }).then((r) => r.json());
  assert.deepEqual(listed.data[0].applies_to, { products: [] });
  await w.run(main, ['sync']);
  assert.equal(company(w, 'Northwind Analytics').properties.rs_mrr, '1300');
});

test('a customer-level discount is flagged end to end, money values left alone (I10)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync']);
  const g = w.stripe.db.customers.find((x) => x.name === 'Globex Logistics');
  g.discount = { id: 'di_cust', object: 'discount', source: { type: 'coupon', coupon: 'RS_SEED_PARTNER20' } };
  const r = await w.run(main, ['reconcile']);
  assert.match(r.out, /Not checked: Globex Logistics[^\n]*customer-level discount/);
  assert.equal(company(w, 'Globex Logistics').properties.rs_mrr, '2000');
});

test('a coupon deleted in Stripe flags its company instead of crashing or guessing (m10)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync']);
  w.stripe.db.coupons.splice(w.stripe.db.coupons.findIndex((c) => c.id === 'RS_SEED_PARTNER20'), 1);
  const r = await w.run(main, ['reconcile']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Not checked: Northwind Analytics[^\n]*coupon was not readable/);
});

test('a deleted Stripe customer whose company is still linked by usage keeps the link: status none, MRR 0, not unlinked (live check 5)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync', '--usage', 'usage.csv']);
  const g = company(w, 'Globex Logistics');
  assert.equal(g.properties.rs_mrr, '2000');
  const c = w.stripe.db.customers.find((x) => x.name === 'Globex Logistics');
  w.stripe.db.customers.splice(w.stripe.db.customers.indexOf(c), 1);
  for (const s of w.stripe.db.subscriptions) if (s.customer === c.id) s.status = 'canceled';
  const r = await w.run(main, ['sync', '--usage', 'usage.csv']);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.out, /Unlinked: Globex/);
  assert.equal(g.properties.rs_billing_status, 'none');
  assert.equal(g.properties.rs_mrr, '0');
  assert.notEqual(g.properties.rs_active_users_30d, '');
  assert.equal((await w.run(main, ['reconcile', '--usage', 'usage.csv'])).code, 0);
});

test('a sync without --mapping refuses before fetching when the last sync recorded mapping links, so a domain-plus-mapping company keeps its mapped revenue (F3)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const g = company(w, 'Globex Logistics');
  const pied = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
  writeFileSync(join(w.cwd, 'map.csv'), `source,source_id,hubspot_company_id\nstripe,${pied.id},${g.id}\n`);
  assert.equal((await w.run(main, ['sync', '--mapping', 'map.csv'])).code, 0);
  assert.equal(g.properties.rs_mrr, '2490', '$24,000 a year by domain plus $490 a month by mapping');

  const stripeBefore = w.stripe.requests.length;
  const hubBefore = w.hubspot.requests.length;
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 1, r.out + r.err);
  assert.match(r.err, /The last sync linked 1 company through the mapping file \(Globex Logistics\), but this run has no --mapping/);
  assert.match(r.err, /Pass the same --mapping file/);
  assert.match(r.err, /an empty file \(header only/);
  assert.match(r.err, /Nothing was fetched or written/);
  assert.equal(w.stripe.requests.length, stripeBefore, 'decided from the state folder, before any request');
  assert.equal(w.hubspot.requests.length, hubBefore);
  assert.equal(g.properties.rs_mrr, '2490');

  assert.equal((await w.run(main, ['sync', '--allow-unlink'])).code, 1, '--allow-unlink does not bypass it');

  const plan = await w.run(main, ['plan']);
  assert.equal(plan.code, 0, 'plan writes nothing, so it runs');
  assert.match(plan.err, /^Warning: the last sync linked 1 company through the mapping file \(Globex Logistics\), but this run has no --mapping/);

  writeFileSync(join(w.cwd, 'empty.csv'), 'source,source_id,hubspot_company_id\n');
  const dropped = await w.run(main, ['sync', '--mapping', 'empty.csv']);
  assert.equal(dropped.code, 0, dropped.err);
  assert.equal(g.properties.rs_mrr, '2000', 'an empty mapping file says the rows are really gone');
  assert.equal((await w.run(main, ['sync'])).code, 0, 'no mapping links recorded any more, so a plain sync runs');
});

test('a sync without --usage after usage links runs (no refusal) and sends no usage property, so nothing usage-derived can change (F3, usage half)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync', '--usage', 'usage.csv']);
  company(w, 'Globex Logistics').properties.rs_mrr = '1';
  const before = writes(w).length;
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 0, r.err);
  const sent = writes(w).slice(before).flatMap((x) => x.body.inputs.flatMap((i) => Object.keys(i.properties)));
  assert.ok(sent.includes('rs_mrr'), 'the run did write');
  assert.ok(!sent.some((p) => p === 'rs_active_users_30d' || p === 'rs_usage_trend'), sent.join(','));
});

test('a guard refusal stays all-or-nothing and says what it did not write (m11)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync']);
  for (const name of ['Globex Logistics', 'Initrode Health', 'Umbrella Freight']) {
    const c = w.stripe.db.customers.find((x) => x.name === name);
    w.stripe.db.customers.splice(w.stripe.db.customers.indexOf(c), 1);
  }
  const nw = company(w, 'Northwind Analytics');
  nw.properties.rs_mrr = '1500';
  const before = writes(w).length;
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 5);
  assert.match(r.err, /Refused to unlink: 3 of 8 linked companies \(38%\) would be unlinked in one run\./);
  assert.match(r.err, /Nothing was written to HubSpot: not the 3 companies it would unlink, not the 1 other value update across 1 company, and no property was created\./);
  assert.equal(writes(w).length, before);
  assert.equal(nw.properties.rs_mrr, '1500', 'all-or-nothing: an update from a run that tripped the guard is not written');
});

test('the F3 refusal names companies from synced.json, so an overwritten or damaged model.json does not degrade it to ids (pre-public review m-e)', async () => {
  for (const model of ['{}', 'not json']) {
    const w = makeWorld();
    await w.run(main, ['seed', '--hubspot']);
    const g = company(w, 'Globex Logistics');
    const pied = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
    writeFileSync(join(w.cwd, 'map.csv'), `source,source_id,hubspot_company_id\nstripe,${pied.id},${g.id}\n`);
    assert.equal((await w.run(main, ['sync', '--mapping', 'map.csv'])).code, 0);
    assert.equal(JSON.parse(readFileSync(join(w.cwd, '.revenue-sync', 'synced.json'), 'utf8')).names[g.id], 'Globex Logistics');
    writeFileSync(join(w.cwd, '.revenue-sync', 'model.json'), model);
    const r = await w.run(main, ['sync']);
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /through the mapping file \(Globex Logistics\)/, model);
  }
});

test('the F3 refusal sends users to plan with an empty mapping file first, before the destructive sync (pre-public review I2)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const g = company(w, 'Globex Logistics');
  const pied = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
  writeFileSync(join(w.cwd, 'map.csv'), `source,source_id,hubspot_company_id\nstripe,${pied.id},${g.id}\n`);
  await w.run(main, ['sync', '--mapping', 'map.csv']);
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 1);
  assert.match(r.err, /If you stopped using a mapping file, first run plan --mapping with an empty file \(header only: source,source_id,hubspot_company_id\) to see what that clears; then run sync with the same empty file\./);
});

test('reconcile without --mapping after a mapped sync warns first and its advice does not loop into the sync refusal (pre-public review I3)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const g = company(w, 'Globex Logistics');
  const pied = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
  writeFileSync(join(w.cwd, 'map.csv'), `source,source_id,hubspot_company_id\nstripe,${pied.id},${g.id}\n`);
  await w.run(main, ['sync', '--mapping', 'map.csv']);
  const r = await w.run(main, ['reconcile']);
  assert.equal(r.code, 3, 'it still compares: nothing is hidden');
  assert.match(r.err, /^Warning: the last sync linked 1 company through the mapping file \(Globex Logistics\), but this run has no --mapping/);
  assert.match(r.out, /MRR \(rs_mrr\): HubSpot says 2490, billing says 2000/);
  assert.doesNotMatch(r.out, /Run plan to see the writes/, 'plan and sync without --mapping cannot fix this');
  assert.match(r.out, /Reconcile failed, but this run has no --mapping and the last sync used one, so the mapped values above read as disagreements\. Run reconcile again with the same --mapping file\./);
  assert.equal((await w.run(main, ['reconcile', '--mapping', 'map.csv'])).code, 0);
});

test('a key that cannot read the Stripe account is said up front on the first plan, sync and reconcile, before any churn is held (pre-public review I4)', async () => {
  const w = makeWorld({ stripeOptions: { accountForbidden: true } });
  await w.run(main, ['seed', '--hubspot']);
  const warning = /^Warning: the Stripe account could not be identified \(the key may not read the Stripe account \(403\)\)\. A company whose Stripe customer is deleted keeps its last values in HubSpot \(held, not unlinked\), and plain reconcile still exits 0 on it\. Use the full secret key, or clear real churn with sync --allow-unlink\.$/m;
  for (const cmd of ['plan', 'sync', 'reconcile']) {
    const r = await w.run(main, [cmd]);
    assert.equal(r.code, 0, `${cmd}: ${r.err}`);
    assert.match(r.err, warning, cmd);
  }
  const ok = makeWorld();
  await ok.run(main, ['seed', '--hubspot']);
  assert.doesNotMatch((await ok.run(main, ['plan'])).err, /Stripe account could not be identified/);
});

test('a run from another state folder says which folder it uses and warns that the portal holds values it has no record of (pre-public review I1)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const g = company(w, 'Globex Logistics');
  const pied = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
  writeFileSync(join(w.cwd, 'map.csv'), `source,source_id,hubspot_company_id\nstripe,${pied.id},${g.id}\n`);
  const first = await w.run(main, ['sync', '--mapping', 'map.csv']);
  assert.match(first.out, new RegExp(`State folder: ${join(w.cwd, '.revenue-sync').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(no sync recorded here yet\\)\\.`));
  assert.doesNotMatch(first.out, /no record of a sync/, 'a fresh portal holds no values, so there is nothing to warn about');
  const same = await w.run(main, ['plan', '--mapping', 'map.csv']);
  assert.match(same.out, /State folder: [^\n]*\.revenue-sync \(last sync 2026-10-07T09:00:00\.000Z\)\./);
  assert.doesNotMatch(same.out, /no record of a sync/);

  const warning = /Warning: 8 HubSpot companies already hold revenue-sync values, but this state folder has no record of a sync\. Mapping or usage links recorded by a sync from another state folder are unknown here, so a company linked by a mapping row there loses what that row put on it, and a company whose Stripe customer is deleted is held with its old values instead of cleared\. If these values came from another state folder, pass that --dir \(and the same --mapping\); the state folder must persist between runs\./;
  for (const cmd of ['plan', 'reconcile']) {
    const r = await w.run(main, [cmd, '--dir', 'other']);
    assert.match(r.err, warning, cmd);
    assert.match(r.out, /State folder: [^\n]*other \(no sync recorded here yet\)\./, cmd);
  }
});

test('within one state folder the README promise holds; across state folders it is scoped, and cron is told to pass an absolute --dir (pre-public review I1)', async () => {
  const { readFileSync: read } = await import('node:fs');
  const README = read(new URL('../README.md', import.meta.url), 'utf8');
  const cron = README.slice(README.indexOf('- **Schedule it.**'), README.indexOf('- **Unlink guard.**'));
  assert.match(cron, /absolute `--dir`/);
  assert.match(cron, /Within one state folder, forgetting a flag cannot clear anything/);
  assert.doesNotMatch(cron, /^[^\n]*- \*\*Schedule it\.\*\*[^\n]*\. Forgetting a flag cannot clear anything/);
  assert.match(cron, /a `sync` from a folder with no record, on a portal that already holds revenue-sync values, without `--mapping`, refuses with exit 1 before writing anything/);
});

test('reconcile while the unlink guard would refuse says so and names --allow-unlink, instead of sending users to a sync that refuses (pre-public review m-i)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync']);
  for (const name of ['Globex Logistics', 'Initrode Health', 'Umbrella Freight']) {
    const c = w.stripe.db.customers.find((x) => x.name === name);
    w.stripe.db.customers.splice(w.stripe.db.customers.indexOf(c), 1);
  }
  assert.equal((await w.run(main, ['sync'])).code, 5);
  const r = await w.run(main, ['reconcile']);
  assert.equal(r.code, 3);
  assert.match(r.out, /Reconcile failed, and sync is refusing this run \(unlink guard: 3 of 8 linked companies \(38%\) would be unlinked in one run\), so plan and sync alone will not fix it\. Check that STRIPE_API_KEY is the account this portal was synced from and that the mapping and usage files were passed; if the companies really are gone, run sync --allow-unlink\./);
  assert.doesNotMatch(r.out, /Run plan to see the writes that would fix this, then sync\./);
});

test('a cron sync from a state folder with no record, on a portal that already holds values, without --mapping, refuses before any write; the header-only mapping file is the escape (I1 refusal)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const g = company(w, 'Globex Logistics');
  const pied = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
  writeFileSync(join(w.cwd, 'map.csv'), `source,source_id,hubspot_company_id\nstripe,${pied.id},${g.id}\n`);
  assert.equal((await w.run(main, ['sync', '--usage', 'usage.csv', '--mapping', 'map.csv'])).code, 0);
  assert.equal(g.properties.rs_mrr, '2490');

  const before = writes(w).length;
  const cron = await w.run(main, ['sync', '--usage', 'usage.csv', '--dir', 'cronhome']);
  assert.equal(cron.code, 1, cron.out + cron.err);
  assert.match(cron.err, /This state folder \([^)]*cronhome\) has no record of a sync, but 8 HubSpot companies already hold revenue-sync values, and this run has no --mapping\./);
  assert.match(cron.err, /Run with the --dir that sync used \(and the same --mapping\)\./);
  assert.match(cron.err, /first run plan --mapping with an empty file \(header only: source,source_id,hubspot_company_id\) to see what changes, then run sync with the same empty file/);
  assert.match(cron.err, /Nothing was written to HubSpot\./);
  assert.doesNotMatch(cron.err, /Nothing was fetched/, 'HubSpot was read to decide this');
  assert.equal(writes(w).length, before, 'no write');
  assert.equal(g.properties.rs_mrr, '2490');
  assert.match(readFileSync(join(w.cwd, 'cronhome', 'run.log'), 'utf8'), /sync exit=1 [^\n]*has no record of a sync/);
  assert.equal((await w.run(main, ['sync', '--usage', 'usage.csv', '--dir', 'cronhome', '--allow-unlink'])).code, 1, '--allow-unlink is not the escape');

  writeFileSync(join(w.cwd, 'empty.csv'), 'source,source_id,hubspot_company_id\n');
  assert.equal((await w.run(main, ['plan', '--usage', 'usage.csv', '--dir', 'cronhome', '--mapping', 'empty.csv'])).code, 0);
  const escaped = await w.run(main, ['sync', '--usage', 'usage.csv', '--dir', 'cronhome', '--mapping', 'empty.csv']);
  assert.equal(escaped.code, 0, escaped.err);
  assert.doesNotMatch(escaped.out, /^Unlinked:/m, 'with no record every unlink is held, so the escape clears nothing');
});

test('warnings go to stderr so run.log records them, and reconcile prints its state folder (I1 visibility)', async () => {
  const w = makeWorld({ stripeOptions: { accountForbidden: true } });
  await w.run(main, ['seed', '--hubspot']);
  const g = company(w, 'Globex Logistics');
  const pied = w.stripe.db.customers.find((x) => x.name === 'Pied Piper');
  writeFileSync(join(w.cwd, 'map.csv'), `source,source_id,hubspot_company_id\nstripe,${pied.id},${g.id}\n`);
  await w.run(main, ['sync', '--mapping', 'map.csv', '--allow-unlink']);

  const rec = await w.run(main, ['reconcile', '--dir', 'cronhome']);
  assert.match(rec.out, /State folder: [^\n]*cronhome \(no sync recorded here yet\)\./);
  assert.match(rec.err, /Warning: 8 HubSpot companies already hold revenue-sync values, but this state folder has no record of a sync\./);
  assert.match(rec.err, /Warning: the Stripe account could not be identified/);
  assert.doesNotMatch(rec.out, /Warning:/, 'warnings are on stderr only');
  const log = readFileSync(join(w.cwd, 'cronhome', 'run.log'), 'utf8');
  assert.match(log, /reconcile exit=\d[^\n]*has no record of a sync/);
  assert.match(log, /reconcile exit=\d[^\n]*could not be identified/);

  const plan = await w.run(main, ['plan']);
  assert.match(plan.err, /^Warning: the last sync linked 1 company through the mapping file \(Globex Logistics\)/);
  assert.match(readFileSync(join(w.cwd, '.revenue-sync', 'run.log'), 'utf8'), /plan exit=0[^\n]*the last sync linked 1 company through the mapping file/);
});

test('the README says the state folder must persist between runs, naming CI runners and containers (I-2)', async () => {
  const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const state = README.slice(README.indexOf('- **State folder**'), README.indexOf('- **As-of date**'));
  assert.match(state, /must persist between runs/);
  assert.match(state, /CI runner/);
  assert.match(state, /container/);
  assert.match(state, /held with (its|their) old values/);
});
