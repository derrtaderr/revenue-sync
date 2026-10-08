import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStripeClient, encodeForm, validStripeKey, isTestKey, STRIPE_VERSION } from '../src/stripe.mjs';
import { createFakeStripe } from './helpers/fake-stripe.mjs';
import { stripeTestKey, stripeLiveKey, restrictedTestKey } from './helpers/keys.mjs';

const noSleep = async () => {};
const client = (fake, key = stripeTestKey()) => createStripeClient({ key, fetch: fake.fetch, sleep: noSleep, random: () => 0 });

test('encodes nested params the way Stripe expects', () => {
  assert.equal(
    decodeURIComponent(encodeForm({ customer: 'cus_1', items: [{ price: 'p', quantity: 3 }], recurring: { interval: 'year' }, metadata: { a: 'b' } })),
    'customer=cus_1&items[0][price]=p&items[0][quantity]=3&recurring[interval]=year&metadata[a]=b',
  );
});

test('key shape: sk_ and rk_ keys are valid, test keys are recognised', () => {
  assert.ok(validStripeKey(stripeTestKey()));
  assert.ok(validStripeKey(stripeLiveKey()));
  assert.ok(validStripeKey(restrictedTestKey()));
  assert.ok(!validStripeKey('pk_test_abc'));
  assert.ok(!validStripeKey('sk_test_"quoted"'));
  assert.ok(isTestKey(stripeTestKey()));
  assert.ok(isTestKey(restrictedTestKey()));
  assert.ok(!isTestKey(stripeLiveKey()));
  assert.ok(!isTestKey('sk_test'));
});

test('lists every customer across pages with the pinned Stripe-Version and the key only in Authorization', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  for (let i = 0; i < 230; i++) fake.db.customers.push({ id: `cus_${i}`, object: 'customer', email: `a${i}@x.test` });
  const customers = await client(fake).listCustomers();
  assert.equal(customers.length, 230);
  assert.equal(fake.requests.length, 3);
  assert.match(fake.requests[1].query, /starting_after=cus_99/);
  for (const r of fake.requests) {
    assert.equal(r.headers['stripe-version'], STRIPE_VERSION);
    assert.ok(!r.query.includes(stripeTestKey()));
  }
  assert.equal(STRIPE_VERSION, '2026-09-30.endive');
});

test('lists subscriptions of every status with discounts and coupons expanded', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  const c = client(fake);
  const cus = await c.create('/v1/customers', { email: 'a@northwind.example' });
  const prod = await c.create('/v1/products', { name: 'Pro' });
  const price = await c.create('/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 1000, recurring: { interval: 'month' } });
  await c.create('/v1/coupons', { id: 'TEN', percent_off: 10, duration: 'forever' });
  const sub = await c.create('/v1/subscriptions', { customer: cus.id, items: [{ price: price.id }], collection_method: 'send_invoice', days_until_due: 30, discounts: [{ coupon: 'TEN' }] });
  fake.db.subscriptions.find((s) => s.id === sub.id).status = 'canceled';
  const subs = await c.listSubscriptions();
  assert.equal(subs.length, 1, 'canceled subscriptions are included');
  assert.equal(subs[0].discounts[0].source.coupon.percent_off, 10);
  const q = fake.requests.at(-1).query;
  assert.match(decodeURIComponent(q), /status=all/);
  assert.match(decodeURIComponent(q), /expand\[\]=data\.discounts\.source\.coupon/);
});

test('lists open invoices and products', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  fake.db.invoices.push({ id: 'in_1', status: 'open' }, { id: 'in_2', status: 'paid' });
  fake.db.products.push({ id: 'prod_1', name: 'Pro' });
  const c = client(fake);
  assert.deepEqual((await c.listOpenInvoices()).map((i) => i.id), ['in_1']);
  assert.deepEqual((await c.listProducts()).map((p) => p.id), ['prod_1']);
});

test('POSTs are form encoded and carry an Idempotency-Key, so a retried create is not duplicated', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  let first = true;
  fake.failures['POST /v1/customers'] = [() => {
    if (first) { first = false; fake.db.customers.push({ id: 'cus_ghost' }); }
    return new Response('{}', { status: 500 });
  }];
  const c = client(fake);
  await c.create('/v1/customers', { email: 'x@y.example' }, 'seed-x');
  const posts = fake.requests.filter((r) => r.method === 'POST');
  assert.equal(posts.length, 2);
  assert.equal(posts[0].headers['idempotency-key'], 'seed-x');
  assert.equal(posts[1].headers['idempotency-key'], 'seed-x');
  assert.equal(posts[0].headers['content-type'], 'application/x-www-form-urlencoded');
});

test('a rejected key is a plain 401 error that never contains the key', async () => {
  const fake = createFakeStripe({ key: 'something-else' });
  await assert.rejects(client(fake).listCustomers(), (err) => {
    assert.equal(err.status, 401);
    assert.match(err.message, /Stripe rejected the key \(401\)/);
    assert.ok(!err.message.includes(stripeTestKey()));
    return true;
  });
});

test('a restricted key without permission names the resource it needs', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  fake.failures['GET /v1/invoices'] = [() => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'restricted' } }), { status: 403 })];
  await assert.rejects(client(fake).listOpenInvoices(), /needs read access to \/v1\/invoices/);
});

test('rate limiting is retried', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  fake.failures['GET /v1/customers'] = [429, 429];
  assert.deepEqual(await client(fake).listCustomers(), []);
});

test('other Stripe errors give the status, the path and the Stripe error type, never the message body', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  await assert.rejects(client(fake).create('/v1/subscriptions', { customer: 'cus_nope' }), (err) => {
    assert.equal(err.status, 400);
    assert.match(err.message, /\/v1\/subscriptions failed with status 400 \(invalid_request_error, resource_missing\)/);
    return true;
  });
});

test('cancels a subscription with DELETE', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  fake.db.subscriptions.push({ id: 'sub_1', status: 'active' });
  await client(fake).cancelSubscription('sub_1');
  assert.equal(fake.db.subscriptions[0].status, 'canceled');
});

test('the fake keeps a price transform_quantity and tax_behavior, as Stripe returns them', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  const c = client(fake);
  const prod = await c.create('/v1/products', { name: 'Packs' });
  const price = await c.create('/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 10000, recurring: { interval: 'month' }, transform_quantity: { divide_by: 10, round: 'up' }, tax_behavior: 'inclusive' });
  assert.deepEqual(price.transform_quantity, { divide_by: 10, round: 'up' });
  assert.equal(price.tax_behavior, 'inclusive');
});

test('lists coupons with applies_to expanded; a discount coupon does not carry applies_to', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  const c = client(fake);
  await c.create('/v1/coupons', { id: 'ADDON50', percent_off: 50, duration: 'forever', applies_to: { products: ['prod_addon'] } });
  const coupons = await c.listCoupons();
  assert.deepEqual(coupons[0].applies_to, { products: ['prod_addon'] });
  assert.match(decodeURIComponent(fake.requests.at(-1).query), /expand\[\]=data\.applies_to/);
  const cus = await c.create('/v1/customers', { email: 'a@b.example' });
  const prod = await c.create('/v1/products', { name: 'Add-on' });
  const price = await c.create('/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 100, recurring: { interval: 'month' } });
  await c.create('/v1/subscriptions', { customer: cus.id, items: [{ price: price.id }], collection_method: 'send_invoice', days_until_due: 30, discounts: [{ coupon: 'ADDON50' }] });
  const [s] = await c.listSubscriptions();
  assert.equal('applies_to' in s.discounts[0].source.coupon, false, 'Stripe does not include applies_to unless expanded, and a 5-level expand is over the limit');
});

test('a list page without a data array or a boolean has_more is an error, never an empty list (B4)', async () => {
  for (const body of [{}, { data: null, has_more: false }, { data: [], has_more: 'no' }, { object: 'list', data: [] }]) {
    const fake = createFakeStripe({ key: stripeTestKey() });
    fake.failures['GET /v1/customers'] = [() => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })];
    await assert.rejects(client(fake).listCustomers(), /Stripe returned an unexpected list shape from \/v1\/customers/, JSON.stringify(body));
  }
});

test('reads the Stripe account id the key belongs to (B4.3)', async () => {
  const fake = createFakeStripe({ key: stripeTestKey(), accountId: 'acct_1Seed' });
  assert.deepEqual(await client(fake).accountId(), { id: 'acct_1Seed' });
  assert.equal(fake.requests.at(-1).path, '/v1/account');
});

test('a restricted key that may not read the account gives an unknown identity, not an error (B4.3)', async () => {
  const fake = createFakeStripe({ key: stripeTestKey(), accountForbidden: true });
  assert.deepEqual(await client(fake).accountId(), { id: null, reason: 'the key may not read the Stripe account (403)' });
});

test('the fake survives a deleted coupon: retrieve answers Stripe\'s 404 shape, a discount keeps the id (m10)', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  const c = client(fake);
  await c.create('/v1/coupons', { id: 'GONE', percent_off: 10, duration: 'forever' });
  const cus = await c.create('/v1/customers', { email: 'a@b.example' });
  const prod = await c.create('/v1/products', { name: 'P' });
  const price = await c.create('/v1/prices', { product: prod.id, currency: 'usd', unit_amount: 100, recurring: { interval: 'month' } });
  await c.create('/v1/subscriptions', { customer: cus.id, items: [{ price: price.id }], collection_method: 'send_invoice', days_until_due: 30, discounts: [{ coupon: 'GONE' }] });
  const del = await fake.fetch('https://api.stripe.com/v1/coupons/GONE', { method: 'DELETE', headers: { authorization: `Bearer ${stripeTestKey()}`, 'stripe-version': '2026-09-30.endive' } });
  assert.deepEqual(await del.json(), { id: 'GONE', object: 'coupon', deleted: true });
  const get = await fake.fetch('https://api.stripe.com/v1/coupons/GONE', { headers: { authorization: `Bearer ${stripeTestKey()}`, 'stripe-version': '2026-09-30.endive' } });
  assert.equal(get.status, 404);
  assert.equal((await get.json()).error.code, 'resource_missing');
  const [s] = await c.listSubscriptions();
  assert.equal(s.discounts[0].source.coupon, 'GONE');
  assert.deepEqual(await c.listCoupons(), []);
});

// Verified live 2026-10-07: an unrestricted coupon has NO applies_to key, even expanded; a
// restricted one has applies_to.products on the expanded list and on retrieve-with-expand;
// an unexpanded retrieve omits the key for both.
test('the fake answers coupons in the shape Stripe returned live: no applies_to key when unrestricted (live check 1)', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  const c = client(fake);
  await c.create('/v1/coupons', { id: 'ALL20', percent_off: 20, duration: 'forever' });
  await c.create('/v1/coupons', { id: 'ADDON50', percent_off: 50, duration: 'forever', applies_to: { products: ['prod_addon'] } });
  const listed = new Map((await c.listCoupons()).map((x) => [x.id, x]));
  assert.equal('applies_to' in listed.get('ALL20'), false, 'unrestricted: the key is absent, not null');
  assert.deepEqual(listed.get('ADDON50').applies_to, { products: ['prod_addon'] });
  const get = (id, q = '') => fake.fetch(`https://api.stripe.com/v1/coupons/${id}${q}`, { headers: { authorization: `Bearer ${stripeTestKey()}`, 'stripe-version': '2026-09-30.endive' } }).then((r) => r.json());
  assert.deepEqual((await get('ADDON50', '?expand%5B%5D=applies_to')).applies_to, { products: ['prod_addon'] });
  assert.equal('applies_to' in (await get('ALL20', '?expand%5B%5D=applies_to')), false);
  assert.equal('applies_to' in (await get('ADDON50')), false, 'unexpanded retrieve omits it even when restricted');
});
