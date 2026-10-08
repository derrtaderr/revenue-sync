// An in-process stand-in for the Stripe API, used as an injected fetch. It reproduces the
// shapes this tool reads under Stripe-Version 2026-09-30.endive: list envelopes with has_more
// and starting_after, subscriptions hidden when canceled unless status=all, period ends on the
// subscription items, discounts as ids unless expanded (coupon under discount.source.coupon),
// the invoice subscription id under parent.subscription_details, form-encoded POSTs,
// Idempotency-Key replay, and the {error:{type,code,message}} error body.

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const err = (status, type, message, code) => json(status, { error: { type, message, ...(code ? { code } : {}) } });

// Parses a[b][0][c]=v form bodies into nested objects (arrays for numeric keys).
export function parseForm(text) {
  const out = {};
  for (const [rawKey, value] of new URLSearchParams(text)) {
    const keys = rawKey.replace(/\]/g, '').split('[');
    let node = out;
    keys.forEach((k, i) => {
      if (i === keys.length - 1) { node[k] = value; return; }
      node[k] ??= /^\d+$/.test(keys[i + 1]) ? [] : {};
      node = node[k];
    });
  }
  return out;
}

const DAY = 86400;
function addInterval(t, interval, count) {
  const d = new Date(t * 1000);
  if (interval === 'month') d.setUTCMonth(d.getUTCMonth() + count);
  else if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + count);
  else if (interval === 'week') d.setUTCDate(d.getUTCDate() + 7 * count);
  else d.setUTCDate(d.getUTCDate() + count);
  return Math.floor(d.getTime() / 1000);
}

export function createFakeStripe({ key, now = Date.UTC(2026, 9, 7) / 1000, accountId = 'acct_1FakeSeedAccount', accountForbidden = false, emptyAppliesTo = false } = {}) {
  const db = { customers: [], products: [], prices: [], coupons: [], discounts: [], subscriptions: [], invoices: [] };
  const failures = {};
  const account = { id: accountId, forbidden: accountForbidden };
  const idem = new Map();
  const requests = [];
  let seq = 1000;
  const id = (prefix) => `${prefix}_${(seq++).toString(36)}`;

  function list(path, items, q) {
    const limit = Math.min(Number(q.get('limit') ?? 10), 100);
    let start = 0;
    const after = q.get('starting_after');
    if (after) {
      const i = items.findIndex((x) => x.id === after);
      if (i < 0) return err(400, 'invalid_request_error', `No such object: '${after}'`, 'resource_missing');
      start = i + 1;
    }
    const page = items.slice(start, start + limit);
    return json(200, { object: 'list', url: path, has_more: start + limit < items.length, data: page });
  }

  // applies_to is includable: only returned when expanded, which only the coupons list can do
  // within Stripe's 4-level expand limit. Verified live 2026-10-07: an unrestricted coupon has
  // NO applies_to key even when expanded; a restricted one has { products: [...] }.
  // emptyAppliesTo: answer an unrestricted coupon's applies_to as { products: [] } instead, a
  // shape Stripe did not send live but the reader still handles.
  function publicCoupon(c, withAppliesTo) {
    const out = structuredClone(c);
    if (!withAppliesTo || !out.applies_to) delete out.applies_to;
    if (withAppliesTo && emptyAppliesTo && !c.applies_to) out.applies_to = { products: [] };
    return out;
  }

  function expandSub(sub, expand) {
    const out = structuredClone(sub);
    if (expand.some((e) => e.startsWith('data.discounts'))) {
      out.discounts = sub.discounts.map((d) => {
        const disc = structuredClone(db.discounts.find((x) => x.id === d));
        if (expand.includes('data.discounts.source.coupon')) {
          // A deleted coupon cannot be expanded; the discount keeps its id.
          const found = db.coupons.find((c) => c.id === disc.source.coupon);
          if (found) disc.source.coupon = publicCoupon(found, false);
        }
        return disc;
      });
    }
    return out;
  }

  function createSubscription(p) {
    const customer = db.customers.find((c) => c.id === p.customer);
    if (!customer) return err(400, 'invalid_request_error', `No such customer: '${p.customer}'`, 'resource_missing');
    if ('coupon' in p) return err(400, 'invalid_request_error', 'Received unknown parameter: coupon', 'parameter_unknown');
    const trialDays = Number(p.trial_period_days ?? 0);
    const start = now;
    const items = (p.items ?? []).map((it) => {
      const price = db.prices.find((x) => x.id === it.price);
      return { price, quantity: Number(it.quantity ?? 1) };
    });
    if (items.some((it) => !it.price)) return err(400, 'invalid_request_error', 'No such price', 'resource_missing');
    if (new Set(items.map((it) => it.price.currency)).size > 1) return err(400, 'invalid_request_error', 'All prices on a subscription must have the same currency.');
    if (customer.currency && customer.currency !== items[0].price.currency) return err(400, 'invalid_request_error', 'You cannot combine currencies on a single customer.');
    customer.currency = items[0].price.currency;
    if (!p.collection_method && !trialDays && !customer.invoice_settings?.default_payment_method) {
      return err(400, 'invalid_request_error', 'This customer has no attached payment source or default payment method.', 'resource_missing');
    }
    const subId = id('sub');
    const discounts = (p.discounts ?? []).map((d) => {
      const coupon = db.coupons.find((c) => c.id === d.coupon);
      const disc = { id: id('di'), object: 'discount', source: { type: 'coupon', coupon: coupon.id }, start, end: coupon.duration === 'repeating' ? addInterval(start, 'month', coupon.duration_in_months) : null, subscription: subId, customer: customer.id };
      db.discounts.push(disc);
      return disc.id;
    });
    const sub = {
      id: subId, object: 'subscription', customer: customer.id, currency: items[0].price.currency,
      status: trialDays ? 'trialing' : 'active', cancel_at_period_end: false, cancel_at: null, canceled_at: null,
      trial_end: trialDays ? start + trialDays * DAY : null, collection_method: p.collection_method ?? 'charge_automatically',
      discounts, metadata: p.metadata ?? {}, created: start,
      items: {
        object: 'list', has_more: false, url: `/v1/subscription_items?subscription=${subId}`,
        data: items.map((it) => ({
          id: id('si'), object: 'subscription_item', price: structuredClone(it.price), quantity: it.quantity, discounts: [],
          current_period_start: start,
          current_period_end: trialDays ? start + trialDays * DAY : addInterval(start, it.price.recurring.interval, it.price.recurring.interval_count),
        })),
      },
    };
    db.subscriptions.push(sub);
    if (!trialDays) {
      const total = items.reduce((s, it) => s + it.price.unit_amount * it.quantity, 0);
      db.invoices.push({ id: id('in'), object: 'invoice', customer: customer.id, status: 'open', currency: sub.currency, amount_due: total, amount_paid: 0, amount_remaining: total, total, created: start, parent: { type: 'subscription_details', subscription_details: { subscription: subId } } });
    }
    return json(200, sub);
  }

  function post(path, p) {
    if (path === '/v1/customers') {
      const c = { id: id('cus'), object: 'customer', email: p.email ?? null, name: p.name ?? null, metadata: p.metadata ?? {}, created: now, currency: null, balance: 0, discount: null, invoice_settings: { default_payment_method: null } };
      db.customers.push(c);
      return json(200, c);
    }
    if (path === '/v1/products') {
      const x = { id: id('prod'), object: 'product', name: p.name, metadata: p.metadata ?? {}, active: true };
      db.products.push(x);
      return json(200, x);
    }
    if (path === '/v1/prices') {
      const x = {
        id: id('price'), object: 'price', product: p.product, currency: p.currency, unit_amount: Number(p.unit_amount), unit_amount_decimal: String(p.unit_amount),
        billing_scheme: 'per_unit', tiers_mode: null, type: 'recurring', nickname: p.nickname ?? null, metadata: p.metadata ?? {},
        transform_quantity: p.transform_quantity ? { divide_by: Number(p.transform_quantity.divide_by), round: p.transform_quantity.round } : null, tax_behavior: p.tax_behavior ?? 'unspecified',
        recurring: { interval: p.recurring.interval, interval_count: Number(p.recurring.interval_count ?? 1), usage_type: 'licensed' },
      };
      db.prices.push(x);
      return json(200, x);
    }
    if (path === '/v1/coupons') {
      const x = { id: p.id ?? id('co'), object: 'coupon', percent_off: p.percent_off ? Number(p.percent_off) : null, amount_off: p.amount_off ? Number(p.amount_off) : null, currency: p.currency ?? null, duration: p.duration, duration_in_months: p.duration_in_months ? Number(p.duration_in_months) : null, name: p.name ?? null, applies_to: p.applies_to?.products ? { products: p.applies_to.products } : null };
      db.coupons.push(x);
      return json(200, publicCoupon(x, false));
    }
    if (path === '/v1/subscriptions') return createSubscription(p);
    return err(404, 'invalid_request_error', `Unrecognized request URL (POST: ${path}).`);
  }

  const fetch = async (url, init = {}) => {
    const u = new URL(url);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    requests.push({ method, path: u.pathname, query: u.search, headers: Object.fromEntries(headers), body: init.body ?? null });
    const queue = failures[`${method} ${u.pathname}`];
    if (queue?.length) {
      const f = queue.shift();
      if (typeof f === 'function') return f();
      if (f === 429) return json(429, { error: { type: 'invalid_request_error', message: 'Too many requests', code: 'rate_limit' } }, { 'stripe-rate-limited-reason': 'global-rate' });
      return err(f, 'api_error', 'Something went wrong on our end.');
    }
    const auth = headers.get('authorization');
    if (auth !== `Bearer ${key}`) return err(401, 'invalid_request_error', 'Invalid API Key provided.');
    if (headers.get('stripe-version') !== '2026-09-30.endive') return err(400, 'invalid_request_error', 'This test fake only speaks 2026-09-30.endive; send the Stripe-Version header.');
    const q = u.searchParams;
    if (method === 'POST') {
      const ik = headers.get('idempotency-key');
      const memoKey = ik && `${u.pathname} ${ik}`;
      if (memoKey && idem.has(memoKey)) return json(200, idem.get(memoKey));
      const res = post(u.pathname, parseForm(init.body ?? ''));
      if (memoKey && res.status === 200) idem.set(memoKey, await res.clone().json());
      return res;
    }
    const q0 = u.searchParams;
    const couponPath = /^\/v1\/coupons\/(.+)$/.exec(u.pathname);
    if (couponPath) {
      const i = db.coupons.findIndex((c) => c.id === couponPath[1]);
      if (i < 0) return err(404, 'invalid_request_error', `No such coupon: '${couponPath[1]}'`, 'resource_missing');
      if (method === 'DELETE') { db.coupons.splice(i, 1); return json(200, { id: couponPath[1], object: 'coupon', deleted: true }); }
      return json(200, publicCoupon(db.coupons[i], q0.getAll('expand[]').includes('applies_to')));
    }
    if (method === 'DELETE') {
      const m = /^\/v1\/subscriptions\/(.+)$/.exec(u.pathname);
      const sub = m && db.subscriptions.find((s) => s.id === m[1]);
      if (!sub) return err(404, 'invalid_request_error', 'No such subscription', 'resource_missing');
      sub.status = 'canceled';
      sub.canceled_at = now;
      return json(200, sub);
    }
    const expand = q.getAll('expand[]');
    if (u.pathname === '/v1/account') {
      if (account.forbidden) return err(403, 'invalid_request_error', 'The provided key does not have the required permissions for this endpoint.');
      return json(200, { id: account.id, object: 'account', country: 'US', default_currency: 'usd' });
    }
    if (u.pathname === '/v1/customers') return list(u.pathname, db.customers, q);
    if (u.pathname === '/v1/products') return list(u.pathname, db.products, q);
    if (u.pathname === '/v1/coupons') return list(u.pathname, db.coupons.map((c) => publicCoupon(c, expand.includes('data.applies_to'))), q);
    if (u.pathname === '/v1/subscriptions') {
      const status = q.get('status');
      let subs = db.subscriptions;
      if (!status) subs = subs.filter((s) => s.status !== 'canceled');
      else if (status !== 'all') subs = subs.filter((s) => s.status === status);
      return list(u.pathname, subs.map((s) => expandSub(s, expand)), q);
    }
    if (u.pathname === '/v1/invoices') {
      const status = q.get('status');
      return list(u.pathname, status ? db.invoices.filter((i) => i.status === status) : db.invoices, q);
    }
    return err(404, 'invalid_request_error', `Unrecognized request URL (GET: ${u.pathname}).`);
  };

  return { fetch, db, requests, failures, now, account };
}
