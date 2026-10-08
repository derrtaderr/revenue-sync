import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSeed, seedUsageCsv, SEED_COMPANIES, SeedRefused } from '../src/seed.mjs';
import { createStripeClient } from '../src/stripe.mjs';
import { createHubSpotClient } from '../src/hubspot.mjs';
import { parseUsage } from '../src/usage.mjs';
import { computeAccount } from '../src/definitions.mjs';
import { createFakeStripe } from './helpers/fake-stripe.mjs';
import { createFakeHubSpot } from './helpers/fake-hubspot.mjs';
import { stripeTestKey, stripeLiveKey, restrictedTestKey, hubspotToken } from './helpers/keys.mjs';

const opts = { sleep: async () => {}, random: () => 0 };
const stripeFor = (fake, key) => createStripeClient({ key, fetch: fake.fetch, ...opts });

test('refuses a live key before any request', async () => {
  const fake = createFakeStripe({ key: stripeLiveKey() });
  await assert.rejects(runSeed({ stripe: stripeFor(fake, stripeLiveKey()), key: stripeLiveKey() }), (err) => {
    assert.ok(err instanceof SeedRefused);
    assert.match(err.message, /only runs on a Stripe test key \(sk_test_ or rk_test_\)/);
    assert.ok(!err.message.includes(stripeLiveKey()));
    return true;
  });
  assert.equal(fake.requests.length, 0);
});

test('refuses anything that is not a test secret or restricted key', async () => {
  for (const key of ['pk_test_abc', 'sk_test', '', 'rk_live_x']) {
    await assert.rejects(runSeed({ stripe: null, key }), SeedRefused, key);
  }
});

test('a restricted test key is accepted', async () => {
  const fake = createFakeStripe({ key: restrictedTestKey() });
  const r = await runSeed({ stripe: stripeFor(fake, restrictedTestKey()), key: restrictedTestKey() });
  assert.ok(r.created.customers > 0);
});

test('builds a realistic dataset: annual and monthly, seats, discounts, a trial, a cancellation, two subscriptions on one customer, a second currency, a free mail customer', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  const r = await runSeed({ stripe: stripeFor(fake, stripeTestKey()), key: stripeTestKey() });
  const subs = fake.db.subscriptions;
  assert.equal(r.created.customers, fake.db.customers.length);
  assert.ok(subs.some((s) => s.status === 'trialing'));
  assert.ok(subs.some((s) => s.status === 'canceled'));
  assert.ok(subs.some((s) => s.items.data[0].price.recurring.interval === 'year'));
  assert.ok(subs.some((s) => s.items.data[0].quantity > 1));
  assert.ok(subs.some((s) => s.discounts.length));
  assert.ok(subs.some((s) => s.currency === 'eur'));
  const perCustomer = new Map();
  for (const s of subs) perCustomer.set(s.customer, (perCustomer.get(s.customer) ?? 0) + 1);
  assert.ok([...perCustomer.values()].some((n) => n > 1));
  assert.ok(fake.db.customers.some((c) => c.email.endsWith('@gmail.com')));
  for (const c of fake.db.customers) assert.equal(c.metadata.revenue_sync_seed, 'v1');
  assert.ok(fake.requests.filter((x) => x.method === 'POST').every((x) => x.headers['idempotency-key']?.startsWith('revenue-sync-seed-v1-')));
});

test('a second seed finds the data and creates nothing', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  const stripe = stripeFor(fake, stripeTestKey());
  await runSeed({ stripe, key: stripeTestKey() });
  const posts = fake.requests.filter((x) => x.method === 'POST').length;
  const r = await runSeed({ stripe, key: stripeTestKey() });
  assert.equal(r.alreadySeeded, true);
  assert.equal(fake.requests.filter((x) => x.method === 'POST').length, posts);
});

test('with HubSpot, creates only the seed companies whose domain is missing, including one deliberate duplicate domain', async () => {
  const fake = createFakeStripe({ key: stripeTestKey() });
  const hsFake = createFakeHubSpot({ token: hubspotToken() });
  hsFake.addCompany({ name: 'Northwind (already here)', domain: 'northwind.example' });
  const hubspot = createHubSpotClient({ token: hubspotToken(), fetch: hsFake.fetch, ...opts });
  const r = await runSeed({ stripe: stripeFor(fake, stripeTestKey()), key: stripeTestKey(), hubspot });
  const domains = hsFake.companies.map((c) => c.properties.domain);
  assert.equal(domains.filter((d) => d === 'northwind.example').length, 1);
  assert.equal(domains.filter((d) => d === 'massive.example').length, 2, 'the ambiguous-domain demo');
  assert.equal(r.hubspotCreated, SEED_COMPANIES.length - 1);
  const again = await runSeed({ stripe: stripeFor(fake, stripeTestKey()), key: stripeTestKey(), hubspot });
  assert.equal(again.hubspotCreated, 0);
});

test('the usage CSV is deterministic for an as-of date and shows every trend', () => {
  const csv = seedUsageCsv('2026-10-07');
  assert.equal(csv, seedUsageCsv('2026-10-07'));
  const usage = parseUsage(csv);
  assert.deepEqual(usage.problems, []);
  const trend = (id) => computeAccount({ usage: usage.accounts.get(id).events, asOf: '2026-10-07' }).metrics.usage_trend;
  assert.equal(trend('northwind'), 'up');
  assert.equal(trend('globex'), 'flat');
  assert.equal(trend('initrode'), 'down');
  assert.equal(trend('hooli'), 'new');
  assert.equal(usage.accounts.get('acct_7731').domain, null, 'one usage account with no domain, to show an unmatched usage record');
});
