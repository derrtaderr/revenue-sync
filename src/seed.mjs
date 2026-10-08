// seed: a realistic Stripe TEST-mode dataset and a matching usage CSV, so a stranger can go from
// a clean clone to a reconciled run without real customers. It refuses any key that is not a
// test key, before making a single request. Every company is fictional and every domain uses
// the reserved .example top-level domain.

import { isTestKey } from './stripe.mjs';

export class SeedRefused extends Error {}

const TAG = 'v1';
const ik = (name) => `revenue-sync-seed-${TAG}-${name}`;

export const SEED_PRODUCTS = [
  { key: 'starter', name: 'Starter' },
  { key: 'growth', name: 'Growth' },
  { key: 'scale', name: 'Scale' },
];

export const SEED_PRICES = [
  { key: 'starter-monthly', product: 'starter', currency: 'usd', unit_amount: 49000, interval: 'month', nickname: 'Starter monthly' },
  { key: 'growth-monthly', product: 'growth', currency: 'usd', unit_amount: 6500, interval: 'month', nickname: 'Growth monthly, per seat' },
  { key: 'growth-annual', product: 'growth', currency: 'usd', unit_amount: 65000, interval: 'year', nickname: 'Growth annual, per seat' },
  { key: 'scale-annual', product: 'scale', currency: 'usd', unit_amount: 2400000, interval: 'year', nickname: 'Scale annual' },
  { key: 'growth-monthly-eur', product: 'growth', currency: 'eur', unit_amount: 6000, interval: 'month', nickname: 'Growth monthly, per seat (EUR)' },
];

export const SEED_COUPONS = [
  { id: 'RS_SEED_PARTNER20', percent_off: 20, duration: 'forever', name: 'Partner 20% (seed)' },
  { id: 'RS_SEED_LAUNCH100', amount_off: 10000, currency: 'usd', duration: 'repeating', duration_in_months: 3, name: 'Launch $100 off (seed)' },
];

// Each customer and the subscriptions it gets. status 'canceled' is created then canceled.
export const SEED_CUSTOMERS = [
  { key: 'northwind', name: 'Northwind Analytics', email: 'ap@northwind.example', subs: [{ price: 'growth-monthly', quantity: 25, coupon: 'RS_SEED_PARTNER20' }] },
  { key: 'globex', name: 'Globex Logistics', email: 'finance@globex.example', subs: [{ price: 'scale-annual', quantity: 1 }] },
  { key: 'initrode', name: 'Initrode Health', email: 'billing@initrode.example', subs: [{ price: 'growth-annual', quantity: 40 }] },
  { key: 'umbrella', name: 'Umbrella Freight', email: 'ops@umbrella.example', subs: [{ price: 'starter-monthly', quantity: 1 }, { price: 'growth-monthly', quantity: 10 }] },
  { key: 'hooli', name: 'Hooli Robotics', email: 'it@hooli.example', subs: [{ price: 'growth-monthly', quantity: 15, trial_days: 14 }] },
  { key: 'vandelay', name: 'Vandelay Imports', email: 'art@vandelay.example', subs: [{ price: 'starter-monthly', quantity: 1, cancel: true }] },
  { key: 'soylent', name: 'Soylent Foods', email: 'ar@soylent.example', subs: [{ price: 'growth-monthly', quantity: 8, coupon: 'RS_SEED_LAUNCH100' }] },
  { key: 'stark-us', name: 'Stark Biotech (US)', email: 'ap@stark.example', subs: [{ price: 'growth-monthly', quantity: 12 }] },
  { key: 'stark-eu', name: 'Stark Biotech (EU)', email: 'eu-billing@stark.example', subs: [{ price: 'growth-monthly-eur', quantity: 6 }] },
  { key: 'massive', name: 'Massive Dynamic', email: 'billing@massive.example', subs: [{ price: 'growth-monthly', quantity: 5 }] },
  { key: 'piedpiper', name: 'Pied Piper', email: 'richard.pp@gmail.com', subs: [{ price: 'starter-monthly', quantity: 1 }] },
];

// HubSpot companies for --hubspot. Massive Dynamic appears twice on purpose: two companies on
// one domain is the ambiguous case, and the run refuses it with both named.
export const SEED_COMPANIES = [
  { name: 'Northwind Analytics', domain: 'northwind.example' },
  { name: 'Globex Logistics', domain: 'globex.example' },
  { name: 'Initrode Health', domain: 'initrode.example' },
  { name: 'Umbrella Freight', domain: 'umbrella.example' },
  { name: 'Hooli Robotics', domain: 'hooli.example' },
  { name: 'Vandelay Imports', domain: 'vandelay.example' },
  { name: 'Soylent Foods', domain: 'soylent.example' },
  { name: 'Stark Biotech', domain: 'stark.example' },
  { name: 'Massive Dynamic', domain: 'massive.example' },
  { name: 'Massive Dynamic (old record)', domain: 'massive.example' },
];

// Usage accounts: distinct users active in the 30 days before as-of (recent) and the 30 days
// before that (prior). Users 1..min overlap, so flat accounts are the same people.
export const SEED_USAGE = [
  { account: 'northwind', domain: 'northwind.example', prior: 15, recent: 20 },
  { account: 'globex', domain: 'globex.example', prior: 30, recent: 30 },
  { account: 'initrode', domain: 'initrode.example', prior: 40, recent: 25 },
  { account: 'umbrella', domain: 'umbrella.example', prior: 0, recent: 6 },
  { account: 'hooli', domain: 'hooli.example', prior: 0, recent: 9 },
  { account: 'soylent', domain: 'soylent.example', prior: 8, recent: 8 },
  { account: 'stark', domain: 'stark.example', prior: 12, recent: 13 },
  { account: 'massive', domain: 'massive.example', prior: 5, recent: 5 },
  { account: 'acct_7731', domain: '', prior: 3, recent: 4 },
];

function minusDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}

export function seedUsageCsv(asOf) {
  const rows = ['account_id,user_id,date,domain'];
  for (const u of SEED_USAGE) {
    for (let i = 1; i <= Math.max(u.prior, u.recent); i++) {
      const user = `${u.account}-u${String(i).padStart(2, '0')}`;
      if (i <= u.recent) {
        rows.push(`${u.account},${user},${minusDays(asOf, i % 28)},${u.domain}`);
        rows.push(`${u.account},${user},${minusDays(asOf, (i * 7) % 29)},${u.domain}`);
      }
      if (i <= u.prior) rows.push(`${u.account},${user},${minusDays(asOf, 31 + (i % 28))},${u.domain}`);
    }
  }
  return `${rows.join('\n')}\n`;
}

export const REFUSE_MESSAGE = 'seed only runs on a Stripe test key (sk_test_ or rk_test_). It creates customers and subscriptions, which must never happen on a live account. Nothing was sent to Stripe.';

export async function runSeed({ stripe, key, hubspot = null }) {
  if (!isTestKey(key)) throw new SeedRefused(REFUSE_MESSAGE);
  const created = { products: 0, prices: 0, coupons: 0, customers: 0, subscriptions: 0 };

  const existing = (await stripe.listCustomers()).filter((c) => c.metadata?.revenue_sync_seed === TAG);
  const have = new Set(existing.map((c) => c.metadata.seed_key));
  const alreadySeeded = SEED_CUSTOMERS.every((c) => have.has(c.key));

  if (!alreadySeeded) {
    // Idempotency keys make a half-finished seed safe to re-run (Stripe keeps them 24 hours).
    const products = {};
    for (const p of SEED_PRODUCTS) {
      products[p.key] = await stripe.create('/v1/products', { name: p.name, metadata: { revenue_sync_seed: TAG } }, ik(`product-${p.key}`));
      created.products++;
    }
    const prices = {};
    for (const p of SEED_PRICES) {
      prices[p.key] = await stripe.create('/v1/prices', { product: products[p.product].id, currency: p.currency, unit_amount: p.unit_amount, nickname: p.nickname, recurring: { interval: p.interval }, metadata: { revenue_sync_seed: TAG } }, ik(`price-${p.key}`));
      created.prices++;
    }
    for (const c of SEED_COUPONS) {
      await stripe.create('/v1/coupons', c, ik(`coupon-${c.id}`));
      created.coupons++;
    }
    for (const c of SEED_CUSTOMERS) {
      if (have.has(c.key)) continue;
      const customer = await stripe.create('/v1/customers', { name: c.name, email: c.email, metadata: { revenue_sync_seed: TAG, seed_key: c.key } }, ik(`customer-${c.key}`));
      created.customers++;
      for (const [i, s] of c.subs.entries()) {
        const params = {
          customer: customer.id,
          items: [{ price: prices[s.price].id, quantity: s.quantity }],
          collection_method: 'send_invoice',
          days_until_due: 30,
          metadata: { revenue_sync_seed: TAG },
          ...(s.trial_days ? { trial_period_days: s.trial_days } : {}),
          ...(s.coupon ? { discounts: [{ coupon: s.coupon }] } : {}),
        };
        const sub = await stripe.create('/v1/subscriptions', params, ik(`subscription-${c.key}-${i}`));
        created.subscriptions++;
        if (s.cancel) await stripe.cancelSubscription(sub.id);
      }
    }
  }

  let hubspotCreated = 0;
  if (hubspot) {
    const have = new Map();
    for (const co of await hubspot.listCompanies(['name', 'domain'])) {
      const d = co.properties?.domain;
      if (d) have.set(d, (have.get(d) ?? 0) + 1);
    }
    const want = new Map();
    const toCreate = [];
    for (const co of SEED_COMPANIES) {
      want.set(co.domain, (want.get(co.domain) ?? 0) + 1);
      if ((have.get(co.domain) ?? 0) < want.get(co.domain)) toCreate.push({ properties: { name: co.name, domain: co.domain } });
    }
    if (toCreate.length) hubspotCreated = (await hubspot.batchCreate(toCreate)).length;
  }
  return { created, alreadySeeded, hubspotCreated };
}
