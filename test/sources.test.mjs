import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStripeBillingSource, createCsvUsageSource } from '../src/sources.mjs';
import { createStripeClient } from '../src/stripe.mjs';
import { createFakeStripe } from './helpers/fake-stripe.mjs';
import { stripeTestKey } from './helpers/keys.mjs';
import { runSeed } from '../src/seed.mjs';

function stripeSource(options = {}) {
  const key = stripeTestKey();
  const fake = createFakeStripe({ key, ...options });
  const client = createStripeClient({ key, fetch: fake.fetch, sleep: async () => {}, random: () => 0 });
  return { fake, client, source: createStripeBillingSource({ client }) };
}

test('a Stripe billing source reads customers, subscriptions, open invoices, products and coupons as normalized records', async () => {
  const { client, source } = stripeSource();
  await runSeed({ stripe: client, key: stripeTestKey() });
  const r = await source.read();
  assert.equal(source.kind, 'stripe');
  assert.equal(r.customers.length, 11);
  assert.equal(r.subscriptions.length, 12, 'status=all includes the canceled one');
  assert.ok(r.invoices.every((i) => i.status === 'open'));
  assert.ok(r.products instanceof Map && r.products.size === 3);
  assert.ok(r.coupons instanceof Map && r.coupons.has('RS_SEED_PARTNER20'));
});

test('a Stripe billing source reads in the order customers, subscriptions, invoices, products, coupons', async () => {
  const { fake, source } = stripeSource();
  await source.read();
  assert.deepEqual(fake.requests.map((r) => r.path), ['/v1/customers', '/v1/subscriptions', '/v1/invoices', '/v1/products', '/v1/coupons']);
});

test('a Stripe billing source names its identity: the Stripe account id, labelled as a Stripe account', async () => {
  const { source } = stripeSource();
  assert.deepEqual(await source.identity(), { id: 'acct_1FakeSeedAccount', label: 'Stripe account' });
  const forbidden = stripeSource({ accountForbidden: true });
  const id = await forbidden.source.identity();
  assert.equal(id.id, null);
  assert.equal(id.label, 'Stripe account');
  assert.match(id.reason, /403/);
});

test('a CSV usage source returns the accounts and skipped lines the CSV reader returns', async () => {
  const source = createCsvUsageSource({ text: 'account_id,user_id,date,domain\na1,u1,2026-10-01,northwind.example\na1,,2026-10-02,\n' });
  assert.equal(source.kind, 'csv');
  const r = await source.read();
  assert.equal(r.accounts.get('a1').events.length, 1);
  assert.deepEqual(r.problems, [{ line: 3, reason: 'has no user_id' }]);
});
