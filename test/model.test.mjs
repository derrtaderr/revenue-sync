import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildModel, MODEL_SCHEMA, MODEL_VERSION } from '../src/model.mjs';
import { parseMapping } from '../src/mapping.mjs';
import { parseUsage } from '../src/usage.mjs';
import { item, sub, invoice } from './helpers/billing.mjs';

const co = (id, name, domain) => ({ id, properties: { name, domain } });

export function sampleInput() {
  return {
    companies: [co('101', 'Northwind', 'northwind.example'), co('102', 'Globex', 'globex.example'), co('103', 'Acme', 'acme.example')],
    customers: [
      { id: 'cus_nw', email: 'ap@northwind.example', name: 'Northwind' },
      { id: 'cus_gx1', email: 'billing@globex.example', name: 'Globex US' },
      { id: 'cus_gx2', email: 'eu@globex.example', name: 'Globex EU' },
      { id: 'cus_solo', email: 'someone@gmail.com', name: 'Solo founder' },
    ],
    subscriptions: [
      sub({ customer: 'cus_nw', items: [item({ amount: 4000, qty: 10, product: 'prod_pro' })] }),
      sub({ customer: 'cus_gx1', items: [item({ amount: 1000 })] }),
      sub({ customer: 'cus_gx2', items: [item({ amount: 1000, currency: 'eur' })] }),
      sub({ customer: 'cus_solo', items: [item({ amount: 900 })] }),
    ],
    invoices: [invoice({ customer: 'cus_nw', remaining: 40000 })],
    products: new Map([['prod_pro', { id: 'prod_pro', name: 'Pro' }]]),
    usage: parseUsage('account_id,user_id,date,domain\nnw-main,u1,2026-10-01,northwind.example\nnw-main,u2,2026-10-02,\nnw-eu,u3,2026-10-03,\nghost,u9,2026-10-01,\n'),
    mapping: parseMapping('source,source_id,hubspot_company_id\nusage,nw-eu,101\n'),
    asOf: '2026-10-07',
    generatedAt: new Date('2026-10-07T09:00:00Z'),
  };
}

test('the model is versioned and stamped', () => {
  const m = buildModel(sampleInput());
  assert.equal(m.schema, MODEL_SCHEMA);
  assert.equal(m.version, MODEL_VERSION);
  assert.equal(m.as_of, '2026-10-07');
  assert.equal(m.generated_at, '2026-10-07T09:00:00.000Z');
});

test('one account per matched company, sorted by name, with its sources and metrics', () => {
  const m = buildModel(sampleInput());
  assert.deepEqual(m.accounts.map((a) => a.hubspot_company_name), ['Globex', 'Northwind']);
  const nw = m.accounts[1];
  assert.equal(nw.hubspot_company_id, '101');
  assert.equal(nw.domain, 'northwind.example');
  assert.deepEqual(nw.stripe_customer_ids, ['cus_nw']);
  assert.deepEqual(nw.usage_account_ids, ['nw-main', 'nw-eu']);
  assert.deepEqual(nw.matched_by, { cus_nw: 'domain', 'nw-main': 'domain', 'nw-eu': 'mapping' });
  assert.equal(nw.metrics.mrr, 400);
  assert.equal(nw.metrics.plan, 'Pro');
  assert.equal(nw.metrics.outstanding_amount, 400);
  assert.equal(nw.metrics.active_users_30d, 3, 'usage from every matched usage account is combined');
  assert.deepEqual(nw.blocked, []);
});

test('a flagged account names the metrics it could not compute', () => {
  const gx = buildModel(sampleInput()).accounts[0];
  assert.equal(gx.flags[0].code, 'mixed_currency');
  assert.deepEqual(gx.blocked, ['mrr', 'arr', 'outstanding_amount']);
  assert.equal(gx.metrics.mrr, null);
});

test('unmatched and ambiguous records and input problems are carried in the model', () => {
  const input = sampleInput();
  input.usage.problems.push({ line: 9, reason: 'has no user_id' });
  const m = buildModel(input);
  assert.deepEqual(m.unmatched.map((u) => `${u.source}:${u.source_id}`), ['stripe:cus_solo', 'usage:ghost']);
  assert.deepEqual(m.ambiguous, []);
  assert.deepEqual(m.input_problems, [{ file: 'usage', line: 9, reason: 'has no user_id' }]);
});

test('the source counts say what was read', () => {
  const m = buildModel(sampleInput());
  assert.deepEqual(m.sources, { stripe: { customers: 4, subscriptions: 4, open_invoices: 1 }, usage: { accounts: 3, provided: true }, mapping: { provided: false }, hubspot: { companies: 3 } });
});

test('without a usage file every usage value is empty', () => {
  const input = sampleInput();
  input.usage = null;
  const m = buildModel(input);
  assert.equal(m.accounts[1].metrics.active_users_30d, null);
  assert.equal(m.sources.usage.accounts, 0);
});

test('the model records whether a usage source was given', () => {
  assert.equal(buildModel(sampleInput()).sources.usage.provided, true);
  const input = sampleInput();
  input.usage = null;
  assert.equal(buildModel(input).sources.usage.provided, false);
});

test('a company holding revenue-sync values that nothing resolves to any more is listed as unlinked (B1)', () => {
  const input = sampleInput();
  input.companies.push({ id: '104', properties: { name: 'Gone Corp', domain: 'gone.example', rs_mrr: '500', rs_billing_status: 'active' } });
  input.companies.push({ id: '105', properties: { name: 'Cleared Co', domain: 'cleared.example', rs_billing_status: 'unlinked', rs_mrr: '' } });
  input.companies.push({ id: '106', properties: { name: 'Never Synced', domain: 'never.example' } });
  const m = buildModel(input);
  assert.deepEqual(m.unlinked.map((u) => [u.hubspot_company_id, u.cleared]), [['105', true], ['104', false]]);
  assert.match(m.unlinked.find((u) => u.hubspot_company_id === '104').reason, /no Stripe customer or usage account resolves to it any more/);
});

test('an unlinked company that is a candidate of an ambiguous record says so', () => {
  const input = sampleInput();
  input.companies.push({ id: '107', properties: { name: 'Northwind (dupe)', domain: 'northwind.example' } });
  input.companies[0].properties.rs_mrr = '400';
  input.mapping = parseMapping(null);
  const m = buildModel(input);
  const nw = m.unlinked.find((u) => u.hubspot_company_id === '101');
  assert.match(nw.reason, /now ambiguous/);
});

// Stripe Accounts v2 bills an account through customer_account ("acct_..."); this tool reads v1
// customers, so such a subscription or invoice cannot be attributed. It is reported, never
// silently dropped. Shape from Stripe's docs; not read live.
test('a subscription or open invoice billed to an Accounts v2 customer_account is reported as unmatched, not dropped (m13)', () => {
  const input = sampleInput();
  const s = sub({ customer: null, items: [item({ amount: 5000 })] });
  s.customer_account = 'acct_1V2Customer';
  const inv = invoice({ customer: null, remaining: 5000 });
  inv.customer_account = 'acct_1V2Customer';
  const m = buildModel({ ...input, subscriptions: [...input.subscriptions, s], invoices: [...input.invoices, inv] });
  const v2 = m.unmatched.filter((u) => u.source_id === s.id || u.source_id === inv.id);
  assert.equal(v2.length, 2);
  for (const u of v2) {
    assert.equal(u.source, 'stripe');
    assert.equal(u.domain, null);
    assert.match(u.reason, /Stripe Accounts v2 customer account acct_1V2Customer/);
  }
  assert.equal(m.accounts.find((a) => a.hubspot_company_id === '101').metrics.mrr, 400, 'nothing is added to any company');
});

test('a subscription that carries customer_account alongside customer is attributed by customer as usual (m13)', () => {
  const input = sampleInput();
  input.subscriptions[0].customer_account = 'acct_1Mirror';
  const m = buildModel(input);
  assert.equal(m.accounts.find((a) => a.hubspot_company_id === '101').metrics.mrr, 400);
  assert.equal(m.unmatched.some((u) => /Accounts v2/.test(u.reason)), false);
});

test('a mapping row naming a Stripe customer or usage account that is not there is reported by line, not ignored (pre-public review m-i)', () => {
  const input = sampleInput();
  input.mapping = parseMapping('source,source_id,hubspot_company_id\nusage,nw-eu,101\nstripe,cus_typo,101\nusage,nope,102\n');
  const m = buildModel(input);
  assert.deepEqual(m.input_problems.filter((p) => p.file === 'mapping'), [
    { file: 'mapping', line: 3, reason: 'stripe customer cus_typo is not in this Stripe account' },
    { file: 'mapping', line: 4, reason: 'usage account nope is not in the usage file' },
  ]);
  input.usage = null;
  const noUsage = buildModel(input);
  assert.deepEqual(noUsage.input_problems.filter((p) => p.file === 'mapping').map((p) => p.line), [3], 'without --usage a usage row cannot be checked');
});
