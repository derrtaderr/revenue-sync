import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAccount } from '../src/definitions.mjs';
import { item, sub } from './helpers/billing.mjs';

const AS_OF = '2026-10-07';
const compute = (over = {}) => computeAccount({ subscriptions: [], invoices: [], products: new Map(), usage: null, asOf: AS_OF, ...over });

test('MRR of a monthly subscription is unit price times quantity', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 5000, qty: 3 })] })] });
  assert.equal(r.metrics.mrr, 150);
  assert.equal(r.metrics.arr, 1800);
  assert.equal(r.metrics.currency, 'USD');
});

test('annual, quarterly, weekly and daily prices are normalised to a month', () => {
  const cases = [
    [{ amount: 120000, interval: 'year' }, 100],
    [{ amount: 30000, interval: 'month', count: 3 }, 100],
    [{ amount: 1200, interval: 'week' }, 52],
    [{ amount: 100, interval: 'day' }, 30.42],
    [{ amount: 240000, interval: 'year', count: 2 }, 100],
  ];
  for (const [spec, mrr] of cases) assert.equal(compute({ subscriptions: [sub({ items: [item(spec)] })] }).metrics.mrr, mrr, JSON.stringify(spec));
});

test('ARR is twelve times MRR before rounding, so an annual plan reads back whole', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 100000, interval: 'year' })] })] });
  assert.equal(r.metrics.mrr, 83.33);
  assert.equal(r.metrics.arr, 1000);
});

test('several subscriptions and several items add up', () => {
  const r = compute({ subscriptions: [
    sub({ items: [item({ amount: 1000 }), item({ amount: 500, qty: 4 })] }),
    sub({ customer: 'cus_2', items: [item({ amount: 120000, interval: 'year' })] }),
  ] });
  assert.equal(r.metrics.mrr, 130);
});

test('unit_amount_decimal is used so sub-cent prices are not truncated', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 0, decimal: '0.5', qty: 1000 })] })] });
  assert.equal(r.metrics.mrr, 5);
});

test('only active and past_due subscriptions count toward MRR', () => {
  const statuses = ['active', 'past_due', 'trialing', 'canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired'];
  const r = compute({ subscriptions: statuses.map((status) => sub({ status, items: [item({ amount: 1000 })] })) });
  assert.equal(r.metrics.mrr, 20);
});

test('a company with only a trial has zero MRR, not an empty value', () => {
  const r = compute({ subscriptions: [sub({ status: 'trialing' })] });
  assert.equal(r.metrics.mrr, 0);
  assert.equal(r.metrics.arr, 0);
});

test('a subscription set to cancel at period end still counts until it ends', () => {
  const r = compute({ subscriptions: [sub({ cancelAtPeriodEnd: true, items: [item({ amount: 1000 })] })] });
  assert.equal(r.metrics.mrr, 10);
});

import { discount } from './helpers/billing.mjs';

test('a recurring percent-off discount reduces MRR', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 10000 })], discounts: [discount({ percent_off: 20 })] })] });
  assert.equal(r.metrics.mrr, 80);
});

test('an amount-off discount is per invoice, so an annual plan spreads it over twelve months', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 120000, interval: 'year' })], discounts: [discount({ amount_off: 12000, currency: 'usd' })] })] });
  assert.equal(r.metrics.mrr, 90);
});

test('repeating discounts count until they end; once-only and ended discounts do not', () => {
  const live = discount({ percent_off: 50, duration: 'repeating', end: '2027-01-01' });
  const ended = discount({ percent_off: 50, duration: 'repeating', end: '2026-10-01' });
  const once = discount({ percent_off: 50, duration: 'once' });
  assert.equal(compute({ subscriptions: [sub({ items: [item({ amount: 10000 })], discounts: [live] })] }).metrics.mrr, 50);
  assert.equal(compute({ subscriptions: [sub({ items: [item({ amount: 10000 })], discounts: [ended] })] }).metrics.mrr, 100);
  assert.equal(compute({ subscriptions: [sub({ items: [item({ amount: 10000 })], discounts: [once] })] }).metrics.mrr, 100);
});

test('percent-off applies before amount-off, and a discount never takes MRR below zero', () => {
  const both = [discount({ percent_off: 50 }), discount({ amount_off: 1000, currency: 'usd' })];
  assert.equal(compute({ subscriptions: [sub({ items: [item({ amount: 10000 })], discounts: both })] }).metrics.mrr, 40);
  const huge = [discount({ amount_off: 999999, currency: 'usd' })];
  assert.equal(compute({ subscriptions: [sub({ items: [item({ amount: 10000 })], discounts: huge })] }).metrics.mrr, 0);
});

test('a discount Stripe returned unexpanded (an id string) blocks money values instead of being ignored', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 10000 })], discounts: ['di_123'] })] });
  assert.equal(r.metrics.mrr, null);
  assert.deepEqual(r.flags.map((f) => f.code), ['unsupported_discount']);
});

test('two currencies on one company are flagged and never summed', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 1000 })] }), sub({ customer: 'cus_2', items: [item({ amount: 1000, currency: 'eur' })] })] });
  assert.equal(r.metrics.mrr, null);
  assert.equal(r.metrics.arr, null);
  assert.equal(r.metrics.currency, null);
  assert.equal(r.flags[0].code, 'mixed_currency');
  assert.match(r.flags[0].detail, /EUR.*USD|USD.*EUR/);
});

test('metered and tiered prices are flagged instead of being priced wrong', () => {
  const metered = compute({ subscriptions: [sub({ items: [item({ usage: 'metered' })] })] });
  assert.equal(metered.metrics.mrr, null);
  assert.equal(metered.flags[0].code, 'unsupported_price');
  const tiered = compute({ subscriptions: [sub({ items: [item({ scheme: 'tiered' })] })] });
  assert.equal(tiered.flags[0].code, 'unsupported_price');
});

test('an item-level discount is flagged (only subscription-level discounts are supported)', () => {
  const it = item({ amount: 1000 });
  it.discounts = ['di_1'];
  const r = compute({ subscriptions: [sub({ items: [it] })] });
  assert.equal(r.metrics.mrr, null);
  assert.equal(r.flags[0].code, 'unsupported_discount');
});

test('zero-decimal currencies are not divided by 100', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 12000, currency: 'jpy' })] })] });
  assert.equal(r.metrics.mrr, 12000);
  assert.equal(r.metrics.currency, 'JPY');
});

test('a canceled subscription in another currency does not make a company mixed', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 1000 })] }), sub({ status: 'canceled', items: [item({ currency: 'eur' })] })] });
  assert.equal(r.metrics.mrr, 10);
  assert.deepEqual(r.flags, []);
});

const products = new Map([['prod_pro', { id: 'prod_pro', name: 'Pro' }], ['prod_seats', { id: 'prod_seats', name: 'Extra seats' }], ['prod_ent', { id: 'prod_ent', name: 'Enterprise' }]]);

test('plan names the products on live subscriptions, biggest first', () => {
  const r = compute({ products, subscriptions: [
    sub({ items: [item({ amount: 1000, product: 'prod_pro' }), item({ amount: 5000, product: 'prod_seats' })] }),
    sub({ status: 'trialing', items: [item({ product: 'prod_ent', amount: 1 })] }),
    sub({ status: 'canceled', items: [item({ product: 'prod_old' })] }),
  ] });
  assert.equal(r.metrics.plan, 'Extra seats + Pro + Enterprise');
});

test('plan falls back to the price nickname, then the price id, and is empty with no live subscription', () => {
  const it = item({ product: 'prod_gone' });
  it.price.nickname = 'Legacy annual';
  assert.equal(compute({ products, subscriptions: [sub({ items: [it] })] }).metrics.plan, 'Legacy annual');
  const bare = item({ product: 'prod_gone' });
  assert.equal(compute({ products, subscriptions: [sub({ items: [bare] })] }).metrics.plan, bare.price.id);
  assert.equal(compute({ products, subscriptions: [sub({ status: 'canceled' })] }).metrics.plan, null);
});

test('billing status puts the state that needs attention first', () => {
  const st = (...subs) => compute({ subscriptions: subs }).metrics.billing_status;
  assert.equal(st(sub({ status: 'active' }), sub({ status: 'past_due' })), 'past_due');
  assert.equal(st(sub({ status: 'active' }), sub({ status: 'unpaid' })), 'unpaid');
  assert.equal(st(sub({ status: 'active' }), sub({ status: 'trialing' })), 'active');
  assert.equal(st(sub({ status: 'active', cancelAtPeriodEnd: true })), 'canceling');
  assert.equal(st(sub({ status: 'active', cancelAt: 1800000000 })), 'canceling');
  assert.equal(st(sub({ status: 'active', cancelAtPeriodEnd: true }), sub({ status: 'active' })), 'active');
  assert.equal(st(sub({ status: 'trialing' })), 'trialing');
  assert.equal(st(sub({ status: 'paused' })), 'paused');
  assert.equal(st(sub({ status: 'canceled' }), sub({ status: 'incomplete_expired' })), 'canceled');
  assert.equal(st(), 'none');
});

test('renewal date is the earliest period end on a live subscription that is not set to cancel', () => {
  const r = compute({ subscriptions: [
    sub({ items: [item({ periodEnd: '2027-03-01' })] }),
    sub({ items: [item({ periodEnd: '2026-12-15' })] }),
    sub({ cancelAtPeriodEnd: true, items: [item({ periodEnd: '2026-10-20' })] }),
    sub({ status: 'canceled', items: [item({ periodEnd: '2026-10-10' })] }),
  ] });
  assert.equal(r.metrics.renewal_date, '2026-12-15');
  assert.equal(compute({ subscriptions: [sub({ cancelAtPeriodEnd: true })] }).metrics.renewal_date, null);
});

test('renewal date reads the item period end (endive) and falls back to an older subscription-level one', () => {
  const s = sub({ items: [item()] });
  delete s.items.data[0].current_period_end;
  s.current_period_end = Date.parse('2027-01-31T00:00:00Z') / 1000;
  assert.equal(compute({ subscriptions: [s] }).metrics.renewal_date, '2027-01-31');
});

test('seat count is the total quantity on live subscriptions, trials included', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ qty: 12 }), item({ qty: 1 })] }), sub({ status: 'trialing', items: [item({ qty: 5 })] }), sub({ status: 'canceled', items: [item({ qty: 40 })] })] });
  assert.equal(r.metrics.seat_count, 18);
  assert.equal(compute({}).metrics.seat_count, 0);
});

import { invoice } from './helpers/billing.mjs';

test('outstanding amount is what open invoices still owe', () => {
  const r = compute({ subscriptions: [sub()], invoices: [invoice({ remaining: 12500 }), invoice({ remaining: 2500 }), invoice({ remaining: 9999, status: 'paid' })] });
  assert.equal(r.metrics.outstanding_amount, 150);
});

test('an open invoice in another currency is flagged, not summed', () => {
  const r = compute({ subscriptions: [sub()], invoices: [invoice({ remaining: 100, currency: 'gbp' })] });
  assert.equal(r.metrics.outstanding_amount, null);
  assert.equal(r.flags[0].code, 'mixed_currency');
});

test('open invoices with no live subscription still report what is owed, in their own currency', () => {
  const r = compute({ invoices: [invoice({ remaining: 4200, currency: 'eur' })] });
  assert.equal(r.metrics.outstanding_amount, 42);
  assert.equal(r.metrics.currency, 'EUR');
  assert.equal(r.metrics.mrr, 0);
});

const ev = (user, date) => ({ user_id: user, date });

test('active users 30d counts distinct users active in the 30 days ending on the as-of date', () => {
  const usage = [ev('a', '2026-10-07'), ev('a', '2026-10-01'), ev('b', '2026-09-08'), ev('c', '2026-09-07'), ev('d', '2026-10-08')];
  assert.equal(compute({ usage }).metrics.active_users_30d, 2);
});

test('usage trend compares the last 30 days with the 30 days before, with a 10 percent band', () => {
  const prior = (n) => Array.from({ length: n }, (_, i) => ev(`p${i}`, '2026-08-20'));
  const recent = (n) => Array.from({ length: n }, (_, i) => ev(`r${i}`, '2026-10-01'));
  const trend = (usage) => compute({ usage }).metrics.usage_trend;
  assert.equal(trend([...prior(10), ...recent(11)]), 'up');
  assert.equal(trend([...prior(10), ...recent(9)]), 'down');
  assert.equal(trend([...prior(10), ...recent(10)]), 'flat');
  assert.equal(trend(recent(3)), 'new');
  assert.equal(trend(prior(3)), 'down');
  assert.equal(trend([ev('x', '2026-01-01')]), 'none');
});

test('no usage data matched to the company leaves both usage values empty, not zero', () => {
  const r = compute({ usage: null });
  assert.equal(r.metrics.active_users_30d, null);
  assert.equal(r.metrics.usage_trend, null);
});

test('transform_quantity prices per pack: $100 per 10 seats, 25 seats rounded up is 3 packs', () => {
  const up = compute({ subscriptions: [sub({ items: [item({ amount: 10000, qty: 25, transform: { divide_by: 10, round: 'up' } })] })] });
  assert.equal(up.metrics.mrr, 300);
  assert.equal(up.metrics.seat_count, 25, 'seats are still the quantity the customer holds');
  const down = compute({ subscriptions: [sub({ items: [item({ amount: 10000, qty: 25, transform: { divide_by: 10, round: 'down' } })] })] });
  assert.equal(down.metrics.mrr, 200);
});

test('a coupon restricted to one product discounts only that product (applies_to)', () => {
  const items = [item({ amount: 100000, product: 'prod_core' }), item({ amount: 10000, product: 'prod_addon' })];
  const pct = compute({ subscriptions: [sub({ items, discounts: [discount({ percent_off: 50, appliesTo: { products: ['prod_addon'] } })] })] });
  assert.equal(pct.metrics.mrr, 1050);
  const amt = compute({ subscriptions: [sub({ items, discounts: [discount({ amount_off: 50000, currency: 'usd', appliesTo: { products: ['prod_addon'] } })] })] });
  assert.equal(amt.metrics.mrr, 1000, 'an amount-off never takes more than the products it applies to');
});

test('applies_to is read from the coupons list when the discount coupon does not carry it', () => {
  const items = [item({ amount: 100000, product: 'prod_core' }), item({ amount: 10000, product: 'prod_addon' })];
  const d = discount({ percent_off: 50, appliesTo: undefined });
  const coupons = new Map([[d.source.coupon.id, { id: d.source.coupon.id, applies_to: { products: ['prod_addon'] } }]]);
  assert.equal(compute({ coupons, subscriptions: [sub({ items, discounts: [d] })] }).metrics.mrr, 1050);
});

test('a coupon whose product restrictions cannot be read blocks money values instead of guessing', () => {
  const d = discount({ percent_off: 50, appliesTo: undefined });
  const r = compute({ coupons: new Map(), subscriptions: [sub({ items: [item({ amount: 10000 })], discounts: [d] })] });
  assert.equal(r.metrics.mrr, null);
  assert.equal(r.flags[0].code, 'unsupported_discount');
  assert.match(r.flags[0].detail, /applies_to/);
});

test('three-decimal currencies are divided by 1000 (BHD, JOD, KWD, OMR, TND)', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 49500, currency: 'kwd' })] })] });
  assert.equal(r.metrics.mrr, 49.5);
  assert.equal(r.metrics.currency, 'KWD');
  assert.equal(compute({ subscriptions: [sub({ items: [item({ amount: 12345, currency: 'bhd' })] })] }).metrics.mrr, 12.345);
});

test('currencies whose Stripe representation the docs leave ambiguous (UGX, ISK) are flagged, not guessed', () => {
  for (const currency of ['ugx', 'isk']) {
    const r = compute({ subscriptions: [sub({ items: [item({ amount: 500000, currency })] })] });
    assert.equal(r.metrics.mrr, null, currency);
    assert.equal(r.flags[0].code, 'unsupported_currency', currency);
  }
});

test('a tax-inclusive price is flagged: MRR is pre-tax and the tax inside the price is not on the price (I6)', () => {
  const r = compute({ subscriptions: [sub({ items: [item({ amount: 12000, tax: 'inclusive' })] })] });
  assert.equal(r.metrics.mrr, null);
  assert.equal(r.flags[0].code, 'tax_inclusive_price');
  assert.equal(compute({ subscriptions: [sub({ items: [item({ amount: 12000, tax: 'exclusive' })] })] }).metrics.mrr, 120);
});

test('an active subscription with collection paused (pause_collection) counts as zero and reads as paused', () => {
  const s = sub({ items: [item({ amount: 10000 })] });
  s.pause_collection = { behavior: 'void', resumes_at: null };
  const r = compute({ subscriptions: [s] });
  assert.equal(r.metrics.mrr, 0);
  assert.equal(r.metrics.billing_status, 'paused');
});

test('applies_to with an empty products list means unrestricted, not "applies to nothing" (I9)', () => {
  const items = [item({ amount: 100000, product: 'prod_core' }), item({ amount: 14000, product: 'prod_addon' })];
  const r = compute({ subscriptions: [sub({ items, discounts: [discount({ percent_off: 50, appliesTo: { products: [] } })] })] });
  assert.equal(r.metrics.mrr, 570);
});

test('a customer-level discount with no discount on the subscriptions blocks money values (I10)', () => {
  const customers = [{ id: 'cus_1', discount: { id: 'di_c', source: { type: 'coupon', coupon: { id: 'C', percent_off: 25, duration: 'forever' } } } }];
  const r = compute({ customers, subscriptions: [sub({ customer: 'cus_1', items: [item({ amount: 10000 })] })] });
  assert.equal(r.metrics.mrr, null);
  assert.equal(r.flags[0].code, 'unsupported_discount');
  assert.match(r.flags[0].detail, /customer cus_1 has a customer-level discount/);
  const covered = compute({ customers, subscriptions: [sub({ customer: 'cus_1', items: [item({ amount: 10000 })], discounts: [discount({ percent_off: 25 })] })] });
  assert.equal(covered.metrics.mrr, 75, 'when the subscription carries the discount it is priced');
});

test('a subscription whose embedded item list is truncated (has_more) is flagged, not undercounted (m9)', () => {
  const s = sub({ items: [item({ amount: 10000 })] });
  s.items.has_more = true;
  const r = compute({ subscriptions: [s] });
  assert.equal(r.metrics.mrr, null);
  assert.equal(r.flags[0].code, 'truncated_items');
});

test('a coupon in the expanded coupons list with no applies_to key is unrestricted, not unreadable (live check 1)', () => {
  const items = [item({ amount: 100000, product: 'prod_core' }), item({ amount: 10000, product: 'prod_addon' })];
  const d = discount({ percent_off: 50, appliesTo: undefined });
  const coupons = new Map([[d.source.coupon.id, { id: d.source.coupon.id, object: 'coupon', percent_off: 50, duration: 'forever' }]]);
  const r = compute({ coupons, subscriptions: [sub({ items, discounts: [d] })] });
  assert.deepEqual(r.flags, []);
  assert.equal(r.metrics.mrr, 550);
});

test('a coupon whose applies_to is present but malformed is flagged, not guessed (live check 1)', () => {
  for (const appliesTo of ['prod_addon', { products: 'prod_addon' }, { products: [7] }, ['prod_addon']]) {
    const d = discount({ percent_off: 50, appliesTo: undefined });
    const coupons = new Map([[d.source.coupon.id, { id: d.source.coupon.id, applies_to: appliesTo }]]);
    const r = compute({ coupons, subscriptions: [sub({ items: [item({ amount: 10000, product: 'prod_addon' })], discounts: [d] })] });
    assert.equal(r.metrics.mrr, null, JSON.stringify(appliesTo));
    assert.equal(r.flags[0]?.code, 'unsupported_discount', JSON.stringify(appliesTo));
    assert.match(r.flags[0].detail, /applies_to/);
  }
});

test('applies_to {} and {products: null} are flagged, not read as unrestricted (pre-public review m-a)', () => {
  for (const appliesTo of [{}, { products: null }]) {
    const d = discount({ percent_off: 50, appliesTo: undefined });
    const coupons = new Map([[d.source.coupon.id, { id: d.source.coupon.id, applies_to: appliesTo }]]);
    const r = compute({ coupons, subscriptions: [sub({ items: [item({ amount: 10000, product: 'prod_addon' })], discounts: [d] })] });
    assert.equal(r.metrics.mrr, null, JSON.stringify(appliesTo));
    assert.equal(r.flags[0]?.code, 'unsupported_discount', JSON.stringify(appliesTo));
  }
});

test('a customer-level discount is flagged when any billing subscription of that customer carries no discount of its own (m12)', () => {
  const customers = [{ id: 'cus_1', discount: { id: 'di_c', source: { type: 'coupon', coupon: { id: 'C', percent_off: 25, duration: 'forever' } } } }];
  const subscriptions = [
    sub({ customer: 'cus_1', items: [item({ amount: 10000 })], discounts: [discount({ percent_off: 10 })] }),
    sub({ customer: 'cus_1', items: [item({ amount: 20000 })] }),
  ];
  const r = compute({ customers, subscriptions });
  assert.equal(r.metrics.mrr, null);
  assert.equal(r.flags[0]?.code, 'unsupported_discount');
  assert.match(r.flags[0].detail, /customer cus_1 has a customer-level discount that 1 of its 2 billing subscriptions do not show/);
});
