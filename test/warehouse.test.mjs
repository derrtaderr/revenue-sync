import { test } from 'node:test';
import assert from 'node:assert/strict';
import { billingFromRows, usageFromRows, BILLING_COLUMNS, ContractError } from '../src/warehouse.mjs';
import { buildModel } from '../src/model.mjs';
import { parseMapping } from '../src/mapping.mjs';
import { createStripeClient } from '../src/stripe.mjs';
import { createStripeBillingSource } from '../src/sources.mjs';
import { runSeed, SEED_COMPANIES } from '../src/seed.mjs';
import { createFakeStripe } from './helpers/fake-stripe.mjs';
import { stripeTestKey } from './helpers/keys.mjs';
import { billingFields, rowsFromStripe } from './helpers/warehouse-rows.mjs';

const companies = SEED_COMPANIES.map((c, i) => ({ id: String(100 + i), properties: { name: c.name, domain: c.domain } }));
const model = (billing) => buildModel({ companies, ...billing, usage: null, mapping: parseMapping(null), asOf: '2026-10-07', generatedAt: new Date('2026-10-07T09:00:00Z') });
const where = 'billing.sql';

async function seeded() {
  const key = stripeTestKey();
  const fake = createFakeStripe({ key });
  const client = createStripeClient({ key, fetch: fake.fetch, sleep: async () => {}, random: () => 0 });
  await runSeed({ stripe: client, key });
  return { fake, stripe: await createStripeBillingSource({ client }).read() };
}

test('the same billing data through the warehouse contract builds the same account model as through the Stripe API', async () => {
  const { fake, stripe } = await seeded();
  const fromStripe = model(stripe);
  const fromWarehouse = model(billingFromRows({ fields: billingFields(), rows: rowsFromStripe(fake.db), where }));
  assert.equal(fromWarehouse.accounts.length, 8);
  assert.deepEqual(fromWarehouse.accounts.map((a) => [a.hubspot_company_name, a.metrics, a.blocked, a.flags.map((f) => f.code)]), fromStripe.accounts.map((a) => [a.hubspot_company_name, a.metrics, a.blocked, a.flags.map((f) => f.code)]));
  assert.deepEqual(fromWarehouse.unmatched.map((u) => u.reason), fromStripe.unmatched.map((u) => u.reason));
  assert.equal(fromWarehouse.accounts.find((a) => a.hubspot_company_name === 'Northwind Analytics').metrics.mrr, 1300);
});

test('no contract column is a GoogleSQL reserved keyword, so a query never needs backticks', () => {
  const reserved = ['all', 'and', 'any', 'array', 'as', 'asc', 'at', 'between', 'by', 'case', 'cast', 'contains', 'create', 'cross', 'cube', 'current', 'default', 'define', 'desc', 'distinct', 'else', 'end', 'enum', 'escape', 'except', 'exclude', 'exists', 'extract', 'false', 'fetch', 'following', 'for', 'from', 'full', 'group', 'grouping', 'groups', 'hash', 'having', 'if', 'ignore', 'in', 'inner', 'intersect', 'interval', 'into', 'is', 'join', 'lateral', 'left', 'like', 'limit', 'lookup', 'merge', 'natural', 'new', 'no', 'not', 'null', 'nulls', 'of', 'on', 'or', 'order', 'outer', 'over', 'partition', 'preceding', 'proto', 'qualify', 'range', 'recursive', 'respect', 'right', 'rollup', 'rows', 'select', 'set', 'some', 'struct', 'tablesample', 'then', 'to', 'treat', 'true', 'unbounded', 'union', 'unnest', 'using', 'when', 'where', 'window', 'with', 'within'];
  for (const c of BILLING_COLUMNS) assert.ok(!reserved.includes(c.name), c.name);
});

test('every contract column must be in the result, with a type the contract allows', () => {
  const fields = billingFields().filter((f) => !['status', 'quantity'].includes(f.name));
  assert.throws(() => billingFromRows({ fields, rows: [], where }), (err) => err instanceof ContractError && /billing\.sql is missing the columns status, quantity/.test(err.message));
  const wrong = billingFields().map((f) => (f.name === 'unit_amount' ? { ...f, type: 'FLOAT64' } : f));
  assert.throws(() => billingFromRows({ fields: wrong, rows: [], where }), /column unit_amount is FLOAT64.*NUMERIC.*a float cannot carry an exact amount/s);
});

const base = (over = []) => {
  const cols = Object.fromEntries(BILLING_COLUMNS.map((c) => [c.name, null]));
  const r = (v) => ({ ...cols, ...v });
  return [
    r({ record: 'customer', customer_id: 'cus_1', customer_email: 'ap@northwind.example', customer_discount: false }),
    r({ record: 'subscription', customer_id: 'cus_1', subscription_id: 'sub_1', status: 'active', currency: 'usd', cancel_at_period_end: false, collection_paused: false }),
    r({ record: 'item', subscription_id: 'sub_1', item_discounted: false, item_id: 'si_1', price_id: 'price_1', product_id: 'prod_1', product_name: 'Growth', unit_amount: '6500', billing_interval: 'month', interval_count: '1', usage_type: 'licensed', billing_scheme: 'per_unit', tax_behavior: 'exclusive', quantity: '10', current_period_end: 1793923200 }),
    ...over.map(r),
  ];
};
const account = (rows) => model(billingFromRows({ fields: billingFields(), rows, where })).accounts[0];

test('a NULL where the record needs a value, an unknown enum value, a duplicate id or an orphan row stops the read, naming the row and column', () => {
  const cases = [
    [(rows) => { rows[2].quantity = null; }, /billing\.sql row 3, column quantity: an item row needs a value/],
    [(rows) => { rows[1].status = 'zombie'; }, /row 2, column status: "zombie" is not one of active, past_due/],
    [(rows) => { rows[2].billing_interval = 'fortnight'; }, /row 3, column billing_interval: "fortnight"/],
    [(rows) => { rows.push({ ...rows[1] }); }, /row 4, column subscription_id: sub_1 appears twice/],
    [(rows) => { rows[2].subscription_id = 'sub_9'; }, /row 3, column subscription_id: no subscription row has sub_9/],
    [(rows) => { rows[0].record = 'invoice'; }, /row 1, column record: "invoice" is not one of customer, subscription, item, discount, open_invoice/],
  ];
  for (const [mutate, re] of cases) {
    const rows = base();
    mutate(rows);
    assert.throws(() => billingFromRows({ fields: billingFields(), rows, where }), re);
  }
});

test('money must be whole minor units: amount_remaining 19.99 is refused, not read as 19.99 cents', () => {
  const rows = base([{ record: 'open_invoice', customer_id: 'cus_1', invoice_id: 'in_1', currency: 'usd', amount_remaining: '19.99' }]);
  assert.throws(() => billingFromRows({ fields: billingFields(), rows, where }), /column amount_remaining: 19\.99 is not a whole number of minor units/);
});

test('a coupon whose product restriction was not read (applies_to NULL) flags the company, like an unreadable Stripe coupon', () => {
  const unread = account(base([{ record: 'discount', subscription_id: 'sub_1', discount_id: 'di_1', coupon_id: 'P20', percent_off: '20', duration: 'forever', applies_to: null }]));
  assert.equal(unread.metrics.mrr, null);
  assert.deepEqual(unread.flags.map((f) => f.code), ['unsupported_discount']);
  assert.equal(account(base([{ record: 'discount', subscription_id: 'sub_1', discount_id: 'di_1', coupon_id: 'P20', percent_off: '20', duration: 'forever', applies_to: '' }])).metrics.mrr, 520, 'empty: unrestricted');
  assert.equal(account(base([{ record: 'discount', subscription_id: 'sub_1', discount_id: 'di_1', coupon_id: 'P20', percent_off: '20', duration: 'forever', applies_to: 'prod_other' }])).metrics.mrr, 650, 'restricted to another product');
});

test('the Stripe path\'s fail-closed treatment holds: tiered, metered, tax-inclusive, item discount and customer discount flag money values', () => {
  const flagged = (mutate) => { const rows = base(); mutate(rows); return account(rows); };
  for (const [name, mutate, code] of [
    ['tiered', (r) => { r[2].billing_scheme = 'tiered'; r[2].unit_amount = null; }, 'unsupported_price'],
    ['metered', (r) => { r[2].usage_type = 'metered'; }, 'unsupported_price'],
    ['tax inclusive', (r) => { r[2].tax_behavior = 'inclusive'; }, 'tax_inclusive_price'],
    ['item discount', (r) => { r[2].item_discounted = true; }, 'unsupported_discount'],
    ['customer discount', (r) => { r[0].customer_discount = true; }, 'unsupported_discount'],
    ['ISK', (r) => { r[1].currency = 'isk'; }, 'unsupported_currency'],
  ]) {
    const a = flagged(mutate);
    assert.equal(a.metrics.mrr, null, name);
    assert.ok(a.flags.some((f) => f.code === code), name);
  }
});

test('transform_quantity and three-decimal currencies price as on the Stripe path', () => {
  const packs = base();
  Object.assign(packs[2], { transform_divide_by: '10', transform_round: 'up', quantity: '25' });
  assert.equal(account(packs).metrics.mrr, 195, '25 seats in packs of 10, rounded up: 3 packs at 65');
  const kwd = base();
  kwd[1].currency = 'kwd';
  Object.assign(kwd[2], { unit_amount: '12345', quantity: '1' });
  assert.equal(account(kwd).metrics.mrr, 12.345, 'thousandths');
});

test('usage rows: DATE, TIMESTAMP or string dates; a NULL id is skipped and reported by row', () => {
  const fields = [{ name: 'account_id', type: 'STRING' }, { name: 'user_id', type: 'INT64' }, { name: 'date', type: 'TIMESTAMP' }, { name: 'domain', type: 'STRING' }];
  const r = usageFromRows({ fields, rows: [
    { account_id: 'a1', user_id: '7', date: 1791363600, domain: 'northwind.example' },
    { account_id: 'a1', user_id: null, date: 1791363600, domain: null },
  ], where: 'usage.sql' });
  assert.deepEqual(r.accounts.get('a1').events, [{ user_id: '7', date: '2026-10-07' }]);
  assert.deepEqual(r.problems, [{ line: 2, reason: 'has no user_id' }]);
  const asDate = usageFromRows({ fields: [{ name: 'account_id', type: 'STRING' }, { name: 'user_id', type: 'STRING' }, { name: 'date', type: 'DATE' }], rows: [{ account_id: 'a', user_id: 'u', date: '2026-10-01' }], where: 'usage.sql' });
  assert.equal(asDate.accounts.get('a').events[0].date, '2026-10-01');
  assert.throws(() => usageFromRows({ fields: [{ name: 'account_id', type: 'STRING' }], rows: [], where: 'usage.sql' }), /usage\.sql is missing the columns user_id, date/);
  assert.throws(() => usageFromRows({ fields: [{ name: 'account_id', type: 'FLOAT64' }, { name: 'user_id', type: 'STRING' }, { name: 'date', type: 'DATE' }], rows: [], where: 'usage.sql' }), /column account_id is FLOAT64/);
});

// ---- the documented contract and the shipped examples agree with the code ----
import { readFileSync as read, existsSync } from 'node:fs';
import { USAGE_COLUMNS_SQL } from '../src/warehouse.mjs';

const DOC = existsSync(new URL('../docs/warehouse.md', import.meta.url)) ? read(new URL('../docs/warehouse.md', import.meta.url), 'utf8') : '';
const example = (name) => read(new URL(`../examples/bigquery/${name}`, import.meta.url), 'utf8');

test('docs/warehouse.md documents every billing and usage column with the types the code accepts', () => {
  for (const c of [...BILLING_COLUMNS, ...USAGE_COLUMNS_SQL]) {
    const line = DOC.split('\n').find((l) => l.startsWith(`| \`${c.name}\` |`));
    assert.ok(line, `${c.name} is not in the contract table`);
    for (const t of c.types) assert.ok(line.includes(t), `${c.name} row does not name ${t}`);
  }
});

test('every example billing query outputs every contract column, and the usage examples output the usage columns', () => {
  for (const file of ['stripe-data-pipeline-billing.sql', 'demo-billing.sql']) {
    const sql = example(file);
    for (const c of BILLING_COLUMNS) assert.match(sql, new RegExp(`\\bAS ${c.name}\\b`), `${file} does not output ${c.name}`);
  }
  for (const file of ['product-usage.sql', 'demo-usage.sql']) {
    const sql = example(file);
    for (const c of USAGE_COLUMNS_SQL) assert.match(sql, new RegExp(`\\bAS ${c.name}\\b`), `${file} does not output ${c.name}`);
  }
});

test('m-D: each demo query says how the suite tests it (against the fakes, through a parser of the file) and that it ran on BigQuery on 2026-10-08', () => {
  for (const file of ['demo-billing.sql', 'demo-usage.sql']) {
    const header = example(file).split('\n').filter((l) => l.startsWith('--')).join(' ').replace(/\s*--\s*/g, ' ');
    assert.match(header, /against the fakes, through a parser of this file/, file);
    assert.match(header, /run on BigQuery on 2026-10-08/, file);
    assert.doesNotMatch(header, /Not yet run against BigQuery/i, file);
    assert.doesNotMatch(header, /expected to give/, file);
    assert.doesNotMatch(header, /agreed on every company/, file);
  }
});

test('the Stripe Data Pipeline example says plainly which columns are unverified and that coupon restrictions are flagged', () => {
  const sql = example('stripe-data-pipeline-billing.sql');
  assert.match(sql, /CAST\(NULL AS STRING\) AS applies_to\)\s+-- not documented: flagged/, "the discount branch emits a typed NULL, so UNION ALL keeps the column STRING");
  assert.match(sql, /unverified/i);
  assert.match(sql, /docs\.stripe\.com\/data\/query-billing-data/);
  assert.match(sql, /stripe_testmode/);
});

test('B2: a discount row repeated by a join fan-out is refused, not applied twice', () => {
  const d = { record: 'discount', subscription_id: 'sub_1', discount_id: 'di_1', coupon_id: 'P20', percent_off: '20', duration: 'forever', applies_to: '' };
  assert.equal(account(base([d])).metrics.mrr, 520);
  assert.throws(() => billingFromRows({ fields: billingFields(), rows: base([d, d]), where }), /row 5, column discount_id: di_1 appears twice/);
  assert.throws(() => billingFromRows({ fields: billingFields(), rows: base([{ ...d, discount_id: null }]), where }), /row 4, column discount_id: a discount row needs a value/);
  // Two different discounts with the same coupon are two discounts (Stripe allows stacking by id).
  assert.equal(account(base([d, { ...d, discount_id: 'di_2' }])).metrics.mrr, 416);
});

test('I3: values Stripe cannot produce are refused: fractional or negative quantity, interval_count below 1, percent_off outside (0, 100], negative amounts', () => {
  const disc = { record: 'discount', subscription_id: 'sub_1', discount_id: 'di_1', coupon_id: 'K', duration: 'forever', applies_to: '' };
  const cases = [
    [(r) => { r[2].quantity = '2.5'; }, /column quantity: 2\.5 is not a whole number of 0 or more/],
    [(r) => { r[2].quantity = '-3'; }, /column quantity: -3 is not a whole number of 0 or more/],
    [(r) => { r[2].interval_count = '0'; }, /column interval_count: 0 is not a whole number of 1 or more/],
    [(r) => { r[2].transform_divide_by = '2.5'; r[2].transform_round = 'up'; }, /column transform_divide_by: 2\.5 is not a whole number of 1 or more/],
    [(r) => { r[2].unit_amount = '-6500'; }, /column unit_amount: -6500 is negative/],
    [(r) => { r.push({ ...r[0], record: 'discount', ...disc, percent_off: '250' }); }, /column percent_off: 250 is not more than 0 and at most 100/],
    [(r) => { r.push({ ...r[0], record: 'discount', ...disc, percent_off: '0' }); }, /column percent_off: 0 is not more than 0 and at most 100/],
    [(r) => { r.push({ ...r[0], record: 'discount', ...disc, amount_off: '-100', currency: 'usd' }); }, /column amount_off: -100 is negative/],
    [(r) => { r.push({ ...r[0], record: 'open_invoice', customer_id: 'cus_1', invoice_id: 'in_1', currency: 'usd', amount_remaining: '-5' }); }, /column amount_remaining: -5 is negative/],
  ];
  for (const [mutate, re] of cases) {
    const rows = base();
    mutate(rows);
    assert.throws(() => billingFromRows({ fields: billingFields(), rows, where }), re);
  }
  const zero = base();
  zero[2].quantity = '0';
  assert.equal(account(zero).metrics.mrr, 0, 'quantity 0 is a value Stripe allows');
});

test('a subscription with no item rows is refused in every non-terminal status: a missing item there is a join or load gap, not MRR 0 (I-C)', () => {
  for (const status of ['active', 'past_due', 'trialing', 'unpaid', 'paused', 'incomplete']) {
    const rows = base();
    rows.splice(2, 1);
    rows[1].status = status;
    assert.throws(() => billingFromRows({ fields: billingFields(), rows, where }), /row 2, column subscription_id: subscription sub_1 has no item rows/, status);
  }
});

test('a canceled or incomplete_expired subscription with no item rows is read and contributes nothing: no metric reads its items (I-C)', () => {
  const bare = (status, id) => ({ record: 'subscription', customer_id: 'cus_1', subscription_id: id, status, currency: 'usd', cancel_at_period_end: false, collection_paused: false });
  for (const status of ['canceled', 'incomplete_expired']) {
    // Next to a live subscription: the money values are exactly the live one's.
    const withLive = account(base([bare(status, 'sub_old')]));
    assert.equal(withLive.metrics.mrr, 650, status);
    assert.equal(withLive.metrics.seat_count, 10, status);
    assert.equal(withLive.metrics.plan, 'Growth', status);
    assert.deepEqual(withLive.flags, [], status);
    // Alone: no money value from it, and billing status says canceled.
    const rows = base();
    rows.splice(1, 2, { ...rows[1], ...bare(status, 'sub_old') });
    const alone = account(rows);
    assert.equal(alone.metrics.mrr, 0, status);
    assert.equal(alone.metrics.arr, 0, status);
    assert.equal(alone.metrics.seat_count, 0, status);
    assert.equal(alone.metrics.billing_status, 'canceled', status);
    assert.equal(alone.metrics.renewal_date, null, status);
  }
});

test('m4: a NULL boolean flag is not read as FALSE: customer_discount, item_discounted, cancel_at_period_end and collection_paused are required', () => {
  for (const [row, col] of [[0, 'customer_discount'], [2, 'item_discounted'], [1, 'cancel_at_period_end'], [1, 'collection_paused']]) {
    const rows = base();
    rows[row][col] = null;
    assert.throws(() => billingFromRows({ fields: billingFields(), rows, where }), new RegExp(`column ${col}: an? \\w+ row needs a value`), col);
  }
});

test('m4: docs/warehouse.md says what NULL means for every column a record may leave NULL', () => {
  for (const c of BILLING_COLUMNS.filter((x) => x.required.length < RECORDS_COUNT)) {
    const line = DOC.split('\n').find((l) => l.startsWith(`| \`${c.name}\` |`));
    assert.match(line, /NULL/, `${c.name} does not say what NULL means`);
  }
});
const RECORDS_COUNT = 5;

test('m-A: a discount row carries exactly one of percent_off and a positive amount_off; neither, both or amount_off 0 is refused naming the row and column', () => {
  const d = { record: 'discount', subscription_id: 'sub_1', discount_id: 'di_1', coupon_id: 'K', duration: 'forever', applies_to: '' };
  const cases = [
    [{ percent_off: null, amount_off: null }, /billing\.sql row 4, column percent_off: a discount needs percent_off or amount_off; both are NULL/],
    [{ percent_off: '20', amount_off: '1000', currency: 'usd' }, /billing\.sql row 4, column amount_off: a discount has percent_off or amount_off, not both/],
    [{ amount_off: '0', currency: 'usd' }, /billing\.sql row 4, column amount_off: 0 is not more than 0/],
  ];
  for (const [over, re] of cases) assert.throws(() => billingFromRows({ fields: billingFields(), rows: base([{ ...d, ...over }]), where }), re);
  assert.equal(account(base([{ ...d, percent_off: '20' }])).metrics.mrr, 520, 'percent only');
  assert.equal(account(base([{ ...d, amount_off: '1000', currency: 'usd' }])).metrics.mrr, 640, 'amount only');
});

test('a repeating discount without its end is refused, since it would count forever', () => {
  const rows = base([{ record: 'discount', subscription_id: 'sub_1', discount_id: 'di_1', coupon_id: 'L', amount_off: '1000', currency: 'usd', duration: 'repeating', discount_end: null, applies_to: '' }]);
  assert.throws(() => billingFromRows({ fields: billingFields(), rows, where }), /column discount_end: a repeating discount needs its end/);
});

test('I1: the Data Pipeline example never drops a row silently: every join is a LEFT JOIN (a missing referent becomes a NULL the contract refuses) and every table is filtered by merchant_id', () => {
  const sql = example('stripe-data-pipeline-billing.sql').replace(/--[^\n]*/g, '');
  const joins = [...sql.matchAll(/\b(\w+\s+)?JOIN\b/g)].map((m) => (m[1] ?? '').trim().toUpperCase());
  assert.ok(joins.length > 0);
  for (const kind of joins) assert.ok(kind === 'LEFT' || kind === 'CROSS', `an inner join drops rows silently: ${kind || 'JOIN'}`);
  const tables = [...sql.matchAll(/`your-project\.stripe_testmode\.(\w+)`\s+AS\s+(\w+)/g)];
  assert.ok(tables.length >= 8, 'every Data Pipeline table the query reads');
  for (const [, table, alias] of tables) assert.match(sql, new RegExp(`\\b${alias}\\.merchant_id\\b`), `${table} (${alias}) is not filtered by merchant_id`);
  assert.doesNotMatch(example('stripe-data-pipeline-billing.sql'), /cannot produce a quiet wrong number/);
});
