// THE definitions file. Every number revenue-sync writes to HubSpot is defined here, once, with
// its plain-words meaning next to the code that computes it. docs/metrics.md and the README
// metrics table are generated from this file (npm run gen), and a test fails if they drift.

// Stripe amounts are in the currency's minor unit (docs.stripe.com/currencies, "Specify amounts
// in API requests"). Two decimals unless listed here. Zero-decimal: no minor unit. Three-decimal
// (Stripe's payout docs list BHD, JOD, KWD, OMR, TND; ISO 4217 gives them 3 minor digits):
// thousandths. UGX and ISK are listed as zero-decimal yet "represented as a two-decimal value"
// on the same page's special cases, so they are flagged rather than guessed.
export const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
export const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);
export const AMBIGUOUS_CURRENCY = new Set(['ugx', 'isk']);
const exponent = (currency) => (ZERO_DECIMAL.has(currency) ? 0 : THREE_DECIMAL.has(currency) ? 3 : 2);
const toMajor = (minor, currency) => {
  const e = exponent(currency);
  return Math.round(minor) / 10 ** e;
};

const MONTHS_PER = { month: 1, year: 12, week: 12 / 52, day: 12 / 365 };
export const MONTHLY_STATUSES = ['active', 'past_due'];
export const LIVE_STATUSES = ['active', 'past_due', 'trialing'];
const STATUS_ORDER = ['unpaid', 'past_due', 'active', 'canceling', 'trialing', 'paused', 'canceled'];
const isCanceling = (s) => s.cancel_at_period_end === true || s.cancel_at != null;
const isoDate = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

// Exact monthly amount, in minor units (not rounded), of one licensed per-unit item.
// The quantity Stripe bills for. transform_quantity prices per pack: 25 seats at divide_by 10
// is 3 packs rounded up, 2 rounded down (docs.stripe.com/api/prices/object, transform_quantity).
function billedQuantity(it) {
  const q = it.quantity ?? 1;
  const t = it.price.transform_quantity;
  if (!t?.divide_by) return q;
  return t.round === 'down' ? Math.floor(q / t.divide_by) : Math.ceil(q / t.divide_by);
}

function itemMonthly(it) {
  const p = it.price;
  const unit = Number(p.unit_amount_decimal ?? p.unit_amount);
  const months = MONTHS_PER[p.recurring.interval] * (p.recurring.interval_count || 1);
  return (unit * billedQuantity(it)) / months;
}

const dayStart = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;

// A discount counts toward MRR while it recurs: duration forever, or repeating and not yet
// ended. A once-only discount is a one-off and does not change the run rate.
function liveDiscounts(s, asOf, flag, coupons) {
  const out = [];
  for (const d of s.discounts ?? []) {
    const coupon = d?.source?.coupon;
    if (!coupon || typeof coupon !== 'object') { flag('unsupported_discount', `subscription ${s.id} has a discount whose coupon was not readable`); return null; }
    // applies_to restricts a coupon to some products. Stripe only returns it when expanded, so
    // it comes from the coupons list. Verified live 2026-10-07: an unrestricted coupon has no
    // applies_to key at all, even expanded. So a coupon IN the list without the key is
    // unrestricted; a coupon NOT in the list (deleted, list unread) cannot be read, and a
    // malformed applies_to is not guessed at.
    const listed = 'applies_to' in coupon ? coupon : coupons?.get(coupon.id);
    if (!listed) { flag('unsupported_discount', `subscription ${s.id} has coupon ${coupon.id} whose product restrictions (applies_to) could not be read`); return null; }
    const appliesTo = listed.applies_to ?? null;
    // {} and {products: null} carry no product list, so they are malformed too (pre-public review m-a).
    if (appliesTo !== null && !(typeof appliesTo === 'object' && !Array.isArray(appliesTo) && Array.isArray(appliesTo.products) && appliesTo.products.every((p) => typeof p === 'string'))) {
      flag('unsupported_discount', `subscription ${s.id} has coupon ${coupon.id} whose product restrictions (applies_to) are not in a shape this tool reads`);
      return null;
    }
    if (coupon.duration === 'once') continue;
    if (d.end && d.end <= dayStart(asOf)) continue;
    if (coupon.amount_off && coupon.currency !== s.currency) { flag('unsupported_discount', `subscription ${s.id} has an amount-off coupon in ${coupon.currency}, not ${s.currency}`); return null; }
    // An empty products list is read as unrestricted too: a coupon that applied to nothing would
    // not be on a subscription.
    out.push({ ...coupon, products: appliesTo?.products?.length ? appliesTo.products : null });
  }
  return out;
}

// Exact monthly amount of one subscription after recurring discounts: percent-off first, then
// amount-off (per invoice, so spread over the billing interval), never below zero.
const productOf = (it) => (typeof it.price.product === 'string' ? it.price.product : it.price.product?.id);

// A coupon with applies_to only discounts the items whose product it names; an amount-off never
// takes more than those items are worth.
function subMonthly(s, asOf, flag, coupons) {
  const amounts = s.items.data.map((it) => itemMonthly(it));
  const discounts = liveDiscounts(s, asOf, flag, coupons);
  if (!discounts) return null;
  const r = s.items.data[0]?.price.recurring;
  const months = r ? MONTHS_PER[r.interval] * (r.interval_count || 1) : 1;
  const eligible = (c) => s.items.data.map((it) => !c.products || c.products.includes(productOf(it)));
  for (const c of discounts) {
    if (!c.percent_off) continue;
    eligible(c).forEach((ok, i) => { if (ok) amounts[i] *= 1 - c.percent_off / 100; });
  }
  for (const c of discounts) {
    if (!c.amount_off) continue;
    const ok = eligible(c);
    const base = amounts.reduce((sum, a, i) => sum + (ok[i] ? a : 0), 0);
    if (base <= 0) continue;
    const off = Math.min(c.amount_off / months, base);
    amounts.forEach((a, i) => { if (ok[i]) amounts[i] = a - (off * a) / base; });
  }
  return Math.max(0, amounts.reduce((a, b) => a + b, 0));
}

function context({ subscriptions = [], invoices = [], products = new Map(), coupons = null, customers = [], usage = null, asOf }) {
  const flags = [];
  const flag = (code, detail) => flags.push({ code, detail });
  // pause_collection keeps status active but collects nothing, so it adds nothing to MRR.
  const monthly = subscriptions.filter((s) => MONTHLY_STATUSES.includes(s.status) && !s.pause_collection);
  const owed = invoices.filter((i) => i.status === 'open' && i.amount_remaining > 0);
  const currencies = [...new Set([...monthly.map((s) => s.currency), ...owed.map((i) => i.currency)])].sort();
  for (const cur of currencies) if (AMBIGUOUS_CURRENCY.has(cur)) flag('unsupported_currency', `${cur.toUpperCase()} amounts are documented by Stripe both as zero-decimal and as two-decimal; not guessing which`);
  if (currencies.length > 1) flag('mixed_currency', `subscriptions and open invoices are in ${currencies.map((x) => x.toUpperCase()).join(' and ')}; amounts are not converted or summed`);
  for (const s of monthly) {
    // A subscription embeds at most a page of items; more items than that would be undercounted.
    if (s.items?.has_more) flag('truncated_items', `subscription ${s.id} has more items than Stripe embedded in the list response; its amount cannot be summed from what was returned`);
    for (const it of s.items.data) {
      const p = it.price;
      if (p.recurring?.usage_type === 'metered' || p.billing_scheme !== 'per_unit' || (p.unit_amount_decimal ?? p.unit_amount) == null) {
        flag('unsupported_price', `subscription ${s.id} has a ${p.recurring?.usage_type === 'metered' ? 'metered' : 'tiered or custom'} price (${p.id}); its monthly amount cannot be known in advance`);
      }
      // MRR is pre-tax (as in Stripe's own Billing analytics). An inclusive price has the tax inside
      // it, and the rate lives on tax settings, not on the price, so the net cannot be read here.
      if (p.tax_behavior === 'inclusive') flag('tax_inclusive_price', `subscription ${s.id} has a tax-inclusive price (${p.id}); the pre-tax amount cannot be read from the price`);
      if (it.discounts?.length) flag('unsupported_discount', `subscription ${s.id} has an item-level discount; only subscription-level discounts are supported`);
    }
  }
  // Customer.discount (docs.stripe.com/api/customers/object, "the current discount active on the
  // customer") can reduce invoices without appearing on the subscription. It reaches every
  // subscription that has no discount of its own, so when a customer has one and ANY of its
  // billing subscriptions is bare, the run rate cannot be trusted (m12).
  for (const c of customers) {
    if (!c?.discount) continue;
    const subs = monthly.filter((x) => x.customer === c.id);
    const bare = subs.filter((x) => !(x.discounts ?? []).length);
    if (!bare.length) continue;
    const which = bare.length === subs.length ? 'its subscriptions do not show' : `${bare.length} of its ${subs.length} billing subscriptions do not show`;
    flag('unsupported_discount', `customer ${c.id} has a customer-level discount that ${which}; MRR cannot be computed from the subscriptions alone`);
  }
  let mrrExact = 0;
  for (const s of flags.length ? [] : monthly) {
    const m = subMonthly(s, asOf, flag, coupons);
    if (m === null) { mrrExact = null; break; }
    mrrExact += m;
  }
  const live = subscriptions.filter((s) => LIVE_STATUSES.includes(s.status));
  const owedMinor = owed.reduce((sum, i) => sum + i.amount_remaining, 0);
  return { asOf, usage, subscriptions, products, live, monthly, owedMinor, currency: currencies.length === 1 ? currencies[0] : null, mrrExact, flags, moneyBlocked: flags.length > 0 };
}

export const PROPERTY_GROUP = { name: 'revenue_sync', label: 'Revenue sync' };

export const DEFINITIONS = [
  {
    key: 'mrr', description: "Monthly recurring revenue. For every active or past_due subscription on any Stripe customer matched to the company: each item's unit price times its billed quantity (for a per-pack price with transform_quantity, the quantity divided into packs and rounded the way the price says), converted to a month (a yearly price divided by 12, every 3 months divided by 3, weekly times 52 over 12, daily times 365 over 12), then reduced by subscription-level discounts that recur (percent-off first, then amount-off spread over the billing interval, never below zero). A coupon limited to some products (Stripe's applies_to) only reduces those products, and an amount-off never takes more than they are worth; when a coupon's product limits cannot be read, money values are flagged instead. Once-only and ended discounts are ignored. Trialing, canceled, unpaid, paused and incomplete subscriptions, and active ones with collection paused (pause_collection), count as zero. Pre-tax: exclusive and unspecified prices are taken as they are, and a tax-inclusive price is flagged because the tax inside it cannot be read from the price. Left unwritten, and flagged, when the company is billed in more than one currency, in UGX or ISK, or has a metered, tiered, item-discounted or tax-inclusive price, or a customer-level discount that any of its subscriptions does not show, or a subscription whose item list Stripe truncated.", property: 'rs_mrr', label: 'MRR', type: 'number', fieldType: 'number', money: true,
    compute: (c) => (c.currency ? toMajor(c.mrrExact, c.currency) : 0),
  },
  {
    key: 'arr', description: 'Annual recurring revenue: MRR times 12, computed before MRR is rounded, so an annual plan reads back as its exact yearly price. Flagged and left unwritten in the same cases as MRR.', property: 'rs_arr', label: 'ARR', type: 'number', fieldType: 'number', money: true,
    compute: (c) => (c.currency ? toMajor(c.mrrExact * 12, c.currency) : 0),
  },
  {
    key: 'currency', description: "The ISO currency code (USD, EUR) that MRR, ARR and the outstanding amount are in: the one currency of the company's active and past_due subscriptions and open invoices. Empty when there are none, and empty and flagged when there is more than one.", property: 'rs_billing_currency', label: 'Billing currency', type: 'string', fieldType: 'text',
    compute: (c) => c.currency?.toUpperCase() ?? null,
  },
  {
    key: 'outstanding_amount', description: 'What the company still owes: the sum of amount_remaining on every open Stripe invoice of its matched customers, in the billing currency. Draft, paid, void and uncollectible invoices are not counted. Flagged and left unwritten when the open invoices are in another currency.', property: 'rs_outstanding_amount', label: 'Outstanding amount', type: 'number', fieldType: 'number', money: true,
    compute: (c) => (c.currency ? toMajor(c.owedMinor, c.currency) : 0),
  },
  { key: 'plan', description: "The names of the Stripe products on the company's live subscriptions (active, past_due or trialing), biggest monthly amount first, joined with a plus sign. Falls back to the price nickname, then the price id, when the product has no name. Empty when nothing is live.", property: 'rs_plan', label: 'Plan', type: 'string', fieldType: 'text', compute: planName },
  { key: 'billing_status', description: "One word for the company's billing state, the state that most needs attention winning: unpaid, then past_due, then active, then canceling (every active subscription is set to cancel), then trialing, then paused (including an active subscription with collection paused), then canceled. none when Stripe has no subscription for the company. sync writes unlinked (and clears every other revenue-sync value) on a company that held values but that no Stripe customer or usage account resolves to any more.", property: 'rs_billing_status', label: 'Billing status', type: 'string', fieldType: 'text', compute: billingStatus },
  { key: 'renewal_date', description: 'The next date money is due to renew: the earliest current period end on a live subscription (active, past_due or trialing) that is not set to cancel. For a trial that is the date it converts. Empty when every live subscription is set to cancel, or nothing is live.', property: 'rs_renewal_date', label: 'Renewal date', type: 'date', fieldType: 'date', compute: renewalDate },
  { key: 'seat_count', description: "The total quantity across every item of the company's live subscriptions (active, past_due or trialing). For per-seat pricing that is the seats paid for; a flat item with quantity 1 adds one.", property: 'rs_seat_count', label: 'Seats', type: 'number', fieldType: 'number', compute: seatCount },
  { key: 'active_users_30d', description: "Distinct user_id values in the usage CSV for the company's matched usage accounts, active on any day in the 30 days ending on the as-of date (the as-of date included). Empty, not zero, when no usage account is matched to the company.", property: 'rs_active_users_30d', label: 'Active users (30 days)', type: 'number', fieldType: 'number', usage: true, compute: activeUsers },
  { key: 'usage_trend', description: 'Distinct active users in the last 30 days compared with the 30 days before that: up when it rose by 10 percent or more, down when it fell by 10 percent or more, flat in between, new when there were no users before and some now, none when there were none in either window. Empty when no usage account is matched.', property: 'rs_usage_trend', label: 'Usage trend', type: 'string', fieldType: 'text', usage: true, compute: usageTrend },
];

function planName(c) {
  const weight = new Map();
  for (const s of c.live) {
    for (const it of s.items.data) {
      const p = it.price;
      const name = c.products.get(typeof p.product === 'string' ? p.product : p.product?.id)?.name || p.nickname || p.id;
      const w = MONTHLY_STATUSES.includes(s.status) && p.billing_scheme === 'per_unit' ? itemMonthly(it) || 0 : 0;
      weight.set(name, (weight.get(name) ?? 0) + w);
    }
  }
  const names = [...weight.keys()].sort((a, b) => weight.get(b) - weight.get(a) || a.localeCompare(b));
  return names.length ? names.join(' + ') : null;
}

function billingStatus(c) {
  const states = c.subscriptions.map((s) => {
    if (s.status === 'active' && s.pause_collection) return 'paused';
    if (s.status === 'active' && isCanceling(s)) return 'canceling';
    if (s.status === 'incomplete_expired') return 'canceled';
    return s.status;
  });
  return STATUS_ORDER.find((x) => states.includes(x)) ?? 'none';
}

function periodEnd(s) {
  const ends = s.items.data.map((it) => it.current_period_end).filter((x) => typeof x === 'number');
  if (ends.length) return Math.min(...ends);
  return typeof s.current_period_end === 'number' ? s.current_period_end : null;
}

function renewalDate(c) {
  const ends = c.live.filter((s) => !isCanceling(s)).map(periodEnd).filter((x) => x != null);
  return ends.length ? isoDate(Math.min(...ends)) : null;
}

function seatCount(c) {
  return c.live.reduce((sum, s) => sum + s.items.data.reduce((n, it) => n + (it.quantity ?? 0), 0), 0);
}

export const USAGE_WINDOW_DAYS = 30;
export const TREND_BAND = 0.1;

function addDays(iso, n) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

// Distinct users with activity in the window of `days` days ending `endOffset` days before asOf.
function distinctUsers(usage, asOf, endOffset) {
  const end = addDays(asOf, -endOffset);
  const start = addDays(end, -USAGE_WINDOW_DAYS);
  return new Set(usage.filter((e) => e.date > start && e.date <= end).map((e) => e.user_id)).size;
}

function activeUsers(c) {
  return c.usage ? distinctUsers(c.usage, c.asOf, 0) : null;
}

function usageTrend(c) {
  if (!c.usage) return null;
  const now = distinctUsers(c.usage, c.asOf, 0);
  const before = distinctUsers(c.usage, c.asOf, USAGE_WINDOW_DAYS);
  if (!before) return now ? 'new' : 'none';
  const change = (now - before) / before;
  if (change >= TREND_BAND) return 'up';
  if (change <= -TREND_BAND) return 'down';
  return 'flat';
}

// A company that held revenue-sync values but that no billing or usage record resolves to any
// more is "unlinked": every value is cleared and rs_billing_status says unlinked, so a stale MRR
// can never sit on it looking current.
export const UNLINKED_STATUS = 'unlinked';
export const unlinkedValue = (def) => (def.key === 'billing_status' ? UNLINKED_STATUS : '');

// The definitions a run is responsible for. Without a usage source, the usage properties are
// left exactly as they are in HubSpot: not written, not cleared, not compared.
export function scopedDefinitions(model) {
  return DEFINITIONS.filter((d) => !(d.usage && model?.sources?.usage?.provided === false));
}

export function computeAccount(input) {
  const c = context(input);
  const metrics = {};
  for (const d of DEFINITIONS) metrics[d.key] = d.money && c.moneyBlocked ? null : d.compute(c);
  return { metrics, flags: c.flags };
}
