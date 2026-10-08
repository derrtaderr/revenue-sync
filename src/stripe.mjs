// Minimal Stripe client: list customers, subscriptions (every status, coupons expanded), open
// invoices and products; create and cancel for seeding. The Stripe-Version header is pinned so
// the response shapes this tool reads cannot change under it when the account's default moves.

import { createRequester, ApiError } from './http.mjs';

export const STRIPE_VERSION = '2026-09-30.endive';
const BASE = 'https://api.stripe.com';

// Secret (sk_) and restricted (rk_) keys, test or live. Printable ASCII only; a pasted key with
// quotes or spaces in it can never be sent as a header.
export const validStripeKey = (key) => typeof key === 'string' && /^[sr]k_(test|live)_[A-Za-z0-9]+$/.test(key);
export const isTestKey = (key) => typeof key === 'string' && /^[sr]k_test_[A-Za-z0-9]+$/.test(key);

export const BAD_KEY_MESSAGE = 'STRIPE_API_KEY does not look like a Stripe secret or restricted key (sk_test_, sk_live_, rk_test_ or rk_live_ followed by letters and digits). Copy it again from the Stripe dashboard, under Developers, API keys, with no quotes or spaces inside the value.';

// Stripe's nested form encoding: a[b]=1, items[0][price]=x.
export function encodeForm(params, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') parts.push(encodeForm(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}

function errorFor(status, path, body) {
  if (status === 401) return new ApiError('Stripe rejected the key (401). Check that STRIPE_API_KEY holds a current secret or restricted key for this account.', 401);
  if (status === 403) return new ApiError(`Stripe refused ${path} (403). A restricted key needs read access to ${path} (and write access for seed).`, 403);
  const detail = [body?.error?.type, body?.error?.code].filter((x) => typeof x === 'string' && /^[a-z_]+$/.test(x));
  return new ApiError(`Stripe request to ${path} failed with status ${status}${detail.length ? ` (${detail.join(', ')})` : ''}.`, status);
}

export function createStripeClient({ key, fetch, sleep, random, baseUrl = BASE }) {
  const request = createRequester({ service: 'Stripe', fetch, sleep, random });
  const headers = (extra = {}) => ({ authorization: `Bearer ${key}`, 'stripe-version': STRIPE_VERSION, accept: 'application/json', ...extra });

  async function call(method, path, { query, form, idempotencyKey } = {}) {
    if (!validStripeKey(key)) throw new ApiError(BAD_KEY_MESSAGE);
    const url = new URL(path, baseUrl);
    if (query) url.search = query;
    const init = { method, headers: headers(form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) } : {}) };
    if (form !== undefined) init.body = encodeForm(form);
    const res = await request(url, init);
    if (res.status >= 200 && res.status < 300) return res.body;
    throw errorFor(res.status, path, res.body);
  }

  async function listAll(path, params = {}) {
    const out = [];
    let after;
    for (;;) {
      const query = encodeForm({ limit: 100, ...params, starting_after: after }).replace(/expand%5B\d+%5D/g, 'expand%5B%5D');
      const page = await call('GET', path, { query });
      // A page that is not a list is an error. Reading a missing data array as "no more
      // customers" would make every company look unlinked.
      if (!Array.isArray(page?.data) || typeof page?.has_more !== 'boolean') {
        throw new ApiError(`Stripe returned an unexpected list shape from ${path} (no data array or has_more flag). Nothing was written.`);
      }
      const data = page.data;
      out.push(...data);
      if (!page.has_more) return out;
      if (!data.length) throw new ApiError(`Stripe said ${path} has more pages but sent an empty page. Nothing was written.`);
      after = data.at(-1).id;
    }
  }

  return {
    // The account the key belongs to, so a later run against a different Stripe account can be
    // told apart. GET /v1/account returns the key's own account; a restricted key without access
    // to it answers 403 or 404, which is reported as an unknown identity, not an error.
    async accountId() {
      try {
        const a = await call('GET', '/v1/account');
        return typeof a?.id === 'string' && a.id.startsWith('acct_') ? { id: a.id } : { id: null, reason: 'Stripe returned no account id' };
      } catch (err) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return { id: null, reason: `the key may not read the Stripe account (${err.status})` };
        throw err;
      }
    },
    listCustomers: () => listAll('/v1/customers'),
    listProducts: () => listAll('/v1/products'),
    listSubscriptions: () => listAll('/v1/subscriptions', { status: 'all', expand: ['data.discounts.source.coupon'] }),
    listOpenInvoices: () => listAll('/v1/invoices', { status: 'open' }),
    // applies_to (product restrictions) is only returned when expanded, and inside a subscription
    // it would be a 5-level expand, over Stripe's limit of 4, so coupons are listed separately.
    listCoupons: () => listAll('/v1/coupons', { expand: ['data.applies_to'] }),
    create: (path, params, idempotencyKey) => call('POST', path, { form: params, idempotencyKey }),
    cancelSubscription: (id) => call('DELETE', `/v1/subscriptions/${encodeURIComponent(id)}`),
  };
}
