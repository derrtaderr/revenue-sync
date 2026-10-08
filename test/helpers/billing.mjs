// Builders for Stripe objects in the endive shape, for metric tests.
let n = 0;
const T = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 1000);

export function item({ amount = 1000, interval = 'month', count = 1, qty = 1, product = 'prod_pro', currency = 'usd', usage = 'licensed', scheme = 'per_unit', periodEnd = '2026-11-01', decimal, transform = null, tax = 'unspecified' } = {}) {
  return {
    id: `si_${++n}`, object: 'subscription_item', quantity: qty, discounts: [],
    current_period_start: T('2026-10-01'), current_period_end: T(periodEnd),
    price: { id: `price_${n}`, object: 'price', product, currency, unit_amount: scheme === 'tiered' ? null : amount, unit_amount_decimal: scheme === 'tiered' ? null : (decimal ?? String(amount)), billing_scheme: scheme, transform_quantity: transform, tax_behavior: tax, nickname: null, type: 'recurring', recurring: { interval, interval_count: count, usage_type: usage } },
  };
}

export function sub({ customer = 'cus_1', status = 'active', items = [item()], discounts = [], cancelAtPeriodEnd = false, cancelAt = null } = {}) {
  return {
    id: `sub_${++n}`, object: 'subscription', customer, status, currency: items[0]?.price.currency ?? 'usd',
    cancel_at_period_end: cancelAtPeriodEnd, cancel_at: cancelAt, discounts, items: { object: 'list', data: items, has_more: false },
  };
}

// appliesTo: undefined leaves applies_to off the coupon, as Stripe returns it inside a discount;
// null or { products: [...] } is the value read from the coupons list.
export function discount(opts = {}) {
  const { percent_off = null, amount_off = null, currency = null, duration = 'forever', end = null } = opts;
  const coupon = { id: `co_${++n}`, object: 'coupon', percent_off, amount_off, currency, duration };
  if (!('appliesTo' in opts)) coupon.applies_to = null;
  else if (opts.appliesTo !== undefined) coupon.applies_to = opts.appliesTo;
  return { id: `di_${n}`, object: 'discount', end: end ? T(end) : null, source: { type: 'coupon', coupon } };
}

export function invoice({ customer = 'cus_1', remaining = 0, currency = 'usd', status = 'open' } = {}) {
  return { id: `in_${++n}`, object: 'invoice', customer, status, currency, amount_remaining: remaining, amount_due: remaining };
}
