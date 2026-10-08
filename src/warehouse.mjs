// The warehouse row contract (docs/warehouse.md). The user's SQL owns the query; its OUTPUT
// COLUMNS are this contract, and every row is checked. Billing rows become exactly the records the
// Stripe API source returns (src/sources.mjs), so the definitions' fail-closed rules apply
// unchanged; usage rows go through the same validation as a usage CSV line.

import { usageFromRecords } from './usage.mjs';

export class ContractError extends Error {}

const ID = ['STRING', 'INT64'];
const TEXT = ['STRING'];
const FLAG = ['BOOL'];
const TIME = ['TIMESTAMP'];
const COUNT = ['INT64', 'NUMERIC'];
// Money is integers in the currency's minor unit, as in the Stripe API. FLOAT64 is refused: a
// float cannot carry an exact amount.
const MONEY = ['NUMERIC', 'BIGNUMERIC', 'INT64'];
const PERCENT = ['NUMERIC', 'BIGNUMERIC', 'INT64', 'FLOAT64'];

export const RECORDS = ['customer', 'subscription', 'item', 'discount', 'open_invoice'];
export const STATUSES = ['active', 'past_due', 'unpaid', 'canceled', 'incomplete', 'incomplete_expired', 'trialing', 'paused'];
// Statuses a subscription never leaves. Only these may arrive with no item rows.
export const TERMINAL = ['canceled', 'incomplete_expired'];

// name, the BigQuery types allowed (the first is the canonical one), the records that need a value,
// allowed values, and the meaning (docs/warehouse.md is checked against this list).
export const BILLING_COLUMNS = [
  { name: 'record', types: TEXT, required: RECORDS, values: RECORDS, meaning: 'Which kind of row this is.' },
  { name: 'customer_id', types: ID, required: ['customer', 'subscription', 'open_invoice'], meaning: 'The billing customer id (Stripe cus_ id when the data comes from Stripe). A mapping row with source stripe places it.' },
  { name: 'customer_name', types: TEXT, required: [], meaning: 'Shown in refusals. NULL: refusals show the email or the id instead.' },
  { name: 'customer_email', types: TEXT, required: [], meaning: 'Its domain is matched when customer_domain is NULL. NULL: there is no email domain to match on.' },
  { name: 'customer_domain', types: TEXT, required: [], meaning: 'Matched against the HubSpot company domain first (Stripe metadata.domain). NULL: the email domain is matched.' },
  { name: 'customer_discount', types: FLAG, required: ['customer'], meaning: 'TRUE when the customer has a customer-level discount; flags money values when a subscription does not show its own.' },
  { name: 'subscription_id', types: ID, required: ['subscription', 'item', 'discount'], meaning: 'The subscription the row belongs to.' },
  { name: 'status', types: TEXT, required: ['subscription'], values: STATUSES, meaning: 'Stripe subscription status.' },
  { name: 'currency', types: TEXT, required: ['subscription', 'open_invoice'], meaning: 'ISO code, any case: the subscription currency, the invoice currency, or an amount-off coupon currency. NULL on a discount is fine for percent-off; an amount-off coupon with NULL currency is flagged.' },
  { name: 'cancel_at_period_end', types: FLAG, required: ['subscription'], meaning: 'TRUE when set to cancel at period end.' },
  { name: 'cancel_at', types: TIME, required: [], meaning: 'When it is set to cancel, if it is. NULL: not set to cancel on a date.' },
  { name: 'collection_paused', types: FLAG, required: ['subscription'], meaning: 'TRUE when payment collection is paused (Stripe pause_collection); counts as zero MRR.' },
  { name: 'item_id', types: ID, required: ['item'], meaning: 'The subscription item id.' },
  { name: 'price_id', types: ID, required: ['item'], meaning: 'The price id.' },
  { name: 'product_id', types: ID, required: ['item'], meaning: 'The product id (coupons restrict by it).' },
  { name: 'product_name', types: TEXT, required: [], meaning: 'The plan name; falls back to price_nickname, then price_id. NULL: price_nickname, then price_id, names the plan.' },
  { name: 'price_nickname', types: TEXT, required: [], meaning: 'The price nickname. NULL: no nickname.' },
  { name: 'unit_amount', types: MONEY, required: [], meaning: 'Per-unit price in minor units; NULL for a tiered or custom price (flagged).' },
  { name: 'billing_interval', types: TEXT, required: ['item'], values: ['day', 'week', 'month', 'year'], meaning: 'Billing interval.' },
  { name: 'interval_count', types: COUNT, required: ['item'], meaning: 'Intervals between bills (3 for quarterly).' },
  { name: 'usage_type', types: TEXT, required: ['item'], values: ['licensed', 'metered'], meaning: 'metered is flagged.' },
  { name: 'billing_scheme', types: TEXT, required: ['item'], values: ['per_unit', 'tiered'], meaning: 'tiered is flagged.' },
  { name: 'tax_behavior', types: TEXT, required: ['item'], values: ['exclusive', 'inclusive', 'unspecified'], meaning: 'inclusive is flagged.' },
  { name: 'transform_divide_by', types: COUNT, required: [], meaning: 'Per-pack pricing (Stripe transform_quantity.divide_by). NULL: priced per unit, not per pack.' },
  { name: 'transform_round', types: TEXT, required: [], values: ['up', 'down'], meaning: 'How packs round; needed with transform_divide_by. NULL unless transform_divide_by is set.' },
  { name: 'quantity', types: COUNT, required: ['item'], meaning: 'Quantity (seats).' },
  { name: 'current_period_end', types: TIME, required: ['item'], meaning: 'The item\'s current period end (renewal date).' },
  { name: 'item_discounted', types: FLAG, required: ['item'], meaning: 'TRUE when the item carries its own discount; flagged.' },
  { name: 'discount_id', types: ID, required: ['discount'], meaning: 'The discount id (Stripe di_), unique: a discount row repeated by a join is refused, never applied twice.' },
  { name: 'coupon_id', types: ID, required: ['discount'], meaning: 'The coupon id.' },
  { name: 'percent_off', types: PERCENT, required: [], meaning: 'Percent off, or NULL. NULL: not a percent-off coupon.' },
  { name: 'amount_off', types: MONEY, required: [], meaning: 'Amount off per invoice in minor units, or NULL. NULL: not an amount-off coupon.' },
  { name: 'duration', types: TEXT, required: ['discount'], values: ['forever', 'once', 'repeating'], meaning: 'Coupon duration.' },
  { name: 'discount_end', types: TIME, required: [], meaning: 'When a repeating discount ends. NULL: the discount does not end; a repeating discount must have one.' },
  { name: 'applies_to', types: TEXT, required: [], meaning: 'Product restriction: NULL means not read (money values flagged), empty means unrestricted, else comma-separated product ids.' },
  { name: 'invoice_id', types: ID, required: ['open_invoice'], meaning: 'An open invoice id.' },
  { name: 'amount_remaining', types: MONEY, required: ['open_invoice'], meaning: 'What is still owed on the open invoice, in minor units.' },
];

export const USAGE_COLUMNS_SQL = [
  { name: 'account_id', types: ID, meaning: 'The product account.' },
  { name: 'user_id', types: ID, meaning: 'The user who was active.' },
  { name: 'date', types: ['DATE', 'TIMESTAMP', 'DATETIME', 'STRING'], meaning: 'The day of the activity (UTC for a TIMESTAMP).' },
  { name: 'domain', types: TEXT, optional: true, meaning: 'Optional: the account\'s domain, matched against HubSpot.' },
];

const canonical = (t) => ({ INTEGER: 'INT64', FLOAT: 'FLOAT64', BOOLEAN: 'BOOL', STRUCT: 'RECORD' }[t] ?? t);
const allowed = (col, type) => col.types.some((t) => canonical(t) === canonical(type));

function checkColumns(fields, columns, where) {
  const byName = new Map((fields ?? []).map((f) => [f.name, f]));
  const missing = columns.filter((c) => !c.optional && !byName.has(c.name)).map((c) => c.name);
  if (missing.length) throw new ContractError(`${where} is missing the columns ${missing.join(', ')} (see docs/warehouse.md). Nothing was written.`);
  for (const c of columns) {
    const f = byName.get(c.name);
    if (!f) continue;
    if (f.mode === 'REPEATED' || !allowed(c, f.type)) {
      const money = c.types === MONEY ? ', because a float cannot carry an exact amount' : '';
      throw new ContractError(`${where}: column ${c.name} is ${f.mode === 'REPEATED' ? 'REPEATED ' : ''}${canonical(f.type)}; the contract needs ${c.types.join(' or ')}${money}. CAST it in the SQL. Nothing was written.`);
    }
  }
}

const isWhole = (s) => /^-?\d+(\.0*)?$/.test(s);
const lower = (v) => (typeof v === 'string' ? v.toLowerCase() : v);

export function billingFromRows({ fields, rows, where }) {
  checkColumns(fields, BILLING_COLUMNS, where);
  const fail = (i, col, problem) => { throw new ContractError(`${where} row ${i + 1}, column ${col}: ${problem}. Nothing was written.`); };
  const customers = new Map();
  const subs = new Map();
  const invoices = new Map();
  const products = new Map();
  const items = new Set();
  const discounts = new Set();
  const pending = [];

  rows.forEach((raw, i) => {
    const r = { ...raw, record: lower(raw.record) };
    for (const c of BILLING_COLUMNS) {
      const v = r[c.name];
      if (v === null || v === undefined) {
        if (c.required.includes(r.record)) fail(i, c.name, `${/^[aeiou]/.test(r.record) ? 'an' : 'a'} ${r.record} row needs a value`);
        continue;
      }
      if (c.values && !c.values.includes(lower(v))) fail(i, c.name, `${JSON.stringify(v)} is not one of ${c.values.join(', ')}`);
    }
    // Values Stripe cannot produce are refused, not computed with.
    const whole = (col, min) => {
      const v = r[col];
      if (v !== null && !(/^-?\d+(\.0*)?$/.test(String(v)) && Number(v) >= min)) fail(i, col, `${v} is not a whole number of ${min} or more`);
    };
    if (r.record === 'item') { whole('quantity', 0); whole('interval_count', 1); whole('transform_divide_by', 1); }
    for (const col of ['unit_amount', 'amount_off', 'amount_remaining']) if (r[col] !== null && Number(r[col]) < 0) fail(i, col, `${r[col]} is negative`);
    if (r.record === 'discount' && r.percent_off !== null && !(Number(r.percent_off) > 0 && Number(r.percent_off) <= 100)) fail(i, 'percent_off', `${r.percent_off} is not more than 0 and at most 100`);
    // A Stripe coupon has exactly one of the two, and a positive one (docs/SPEC.md divergence 30).
    if (r.record === 'discount') {
      if (r.percent_off === null && r.amount_off === null) fail(i, 'percent_off', 'a discount needs percent_off or amount_off; both are NULL');
      if (r.percent_off !== null && r.amount_off !== null) fail(i, 'amount_off', 'a discount has percent_off or amount_off, not both');
      if (r.amount_off !== null && !(Number(r.amount_off) > 0)) fail(i, 'amount_off', `${r.amount_off} is not more than 0`);
    }
    const money = (col) => {
      const v = r[col];
      if (v === null) return null;
      if (col !== 'unit_amount' && !isWhole(String(v))) fail(i, col, `${v} is not a whole number of minor units (cents, not dollars)`);
      return String(v);
    };
    const currency = (v) => {
      if (v === null) return null;
      const c = v.toLowerCase();
      if (!/^[a-z]{3}$/.test(c)) fail(i, 'currency', `${JSON.stringify(v)} is not a three-letter ISO code`);
      return c;
    };
    const seconds = (v) => (v === null ? null : Math.floor(Number(v)));
    const unique = (map, id, col) => { if (map.has(String(id))) fail(i, col, `${id} appears twice`); };
    if (r.record === 'customer') {
      unique(customers, r.customer_id, 'customer_id');
      customers.set(String(r.customer_id), { id: String(r.customer_id), object: 'customer', name: r.customer_name, email: r.customer_email, metadata: r.customer_domain ? { domain: r.customer_domain } : {}, discount: r.customer_discount ? { object: 'discount', source: 'warehouse' } : null });
    } else if (r.record === 'subscription') {
      unique(subs, r.subscription_id, 'subscription_id');
      subs.set(String(r.subscription_id), {
        id: String(r.subscription_id), object: 'subscription', customer: String(r.customer_id), status: r.status.toLowerCase(), currency: currency(r.currency),
        cancel_at_period_end: r.cancel_at_period_end === true, cancel_at: seconds(r.cancel_at), pause_collection: r.collection_paused ? { behavior: 'void' } : null,
        discounts: [], items: { object: 'list', data: [], has_more: false }, row: i,
      });
    } else if (r.record === 'open_invoice') {
      unique(invoices, r.invoice_id, 'invoice_id');
      invoices.set(String(r.invoice_id), { id: String(r.invoice_id), object: 'invoice', customer: String(r.customer_id), status: 'open', currency: currency(r.currency), amount_remaining: Number(money('amount_remaining')), row: i });
    } else pending.push({ r, i, money, currency, seconds });
  });

  for (const { r, i, money, currency, seconds } of pending) {
    const s = subs.get(String(r.subscription_id));
    if (!s) fail(i, 'subscription_id', `no subscription row has ${r.subscription_id}`);
    if (r.record === 'item') {
      if (items.has(String(r.item_id))) fail(i, 'item_id', `${r.item_id} appears twice`);
      items.add(String(r.item_id));
      if (r.transform_divide_by !== null && r.transform_round === null) fail(i, 'transform_round', 'transform_divide_by needs transform_round');
      const unit = money('unit_amount');
      const product = String(r.product_id);
      if (!products.has(product) || (!products.get(product).name && r.product_name)) products.set(product, { id: product, object: 'product', name: r.product_name });
      s.items.data.push({
        id: String(r.item_id), object: 'subscription_item', quantity: Number(r.quantity), discounts: r.item_discounted ? ['item-level'] : [], current_period_end: seconds(r.current_period_end),
        price: {
          id: String(r.price_id), object: 'price', product, currency: s.currency, unit_amount: unit === null ? null : Number(unit), unit_amount_decimal: unit,
          billing_scheme: r.billing_scheme.toLowerCase(), tax_behavior: r.tax_behavior.toLowerCase(), nickname: r.price_nickname,
          transform_quantity: r.transform_divide_by === null ? null : { divide_by: Number(r.transform_divide_by), round: r.transform_round.toLowerCase() },
          recurring: { interval: r.billing_interval.toLowerCase(), interval_count: Number(r.interval_count), usage_type: r.usage_type.toLowerCase() },
        },
      });
    } else {
      if (discounts.has(String(r.discount_id))) fail(i, 'discount_id', `${r.discount_id} appears twice`);
      discounts.add(String(r.discount_id));
      // applies_to NULL: the restriction was not read, so the coupon carries no applies_to key and
      // is not in the coupons map, which the definitions flag (as for an unreadable Stripe coupon).
      if (r.duration.toLowerCase() === 'repeating' && r.discount_end === null) fail(i, 'discount_end', 'a repeating discount needs its end (Stripe always sets one); without it the discount would count forever');
      const coupon = { id: String(r.coupon_id), object: 'coupon', percent_off: r.percent_off === null ? null : Number(r.percent_off), amount_off: r.amount_off === null ? null : Number(money('amount_off')), currency: currency(r.currency), duration: r.duration.toLowerCase() };
      if (r.applies_to !== null) {
        const list = r.applies_to.split(',').map((x) => x.trim()).filter(Boolean);
        coupon.applies_to = list.length ? { products: list } : null;
      }
      s.discounts.push({ id: String(r.discount_id), object: 'discount', end: seconds(r.discount_end), source: { type: 'coupon', coupon } });
    }
  }
  for (const s of subs.values()) if (!customers.has(s.customer)) fail(s.row, 'customer_id', `no customer row has ${s.customer}`);
  // A missing item is a join or load gap, never MRR 0, except on a terminal subscription: it can
  // never bill again and no metric reads its items, so a warehouse that drops them changes no value
  // (docs/SPEC.md divergence 29). Every other status, including any added later, is refused.
  for (const s of subs.values()) if (!s.items.data.length && !TERMINAL.includes(s.status)) fail(s.row, 'subscription_id', `subscription ${s.id} has no item rows (a Stripe subscription always has one; a missing item is a join or load gap, not MRR 0)`);
  for (const inv of invoices.values()) if (!customers.has(inv.customer)) fail(inv.row, 'customer_id', `no customer row has ${inv.customer}`);
  const strip = ({ row, ...rest }) => rest;
  return { customers: [...customers.values()], subscriptions: [...subs.values()].map(strip), invoices: [...invoices.values()].map(strip), products, coupons: new Map() };
}

const isoDay = (seconds) => new Date(seconds * 1000).toISOString().slice(0, 10);

export function usageFromRows({ fields, rows, where }) {
  checkColumns(fields, USAGE_COLUMNS_SQL, where);
  const type = Object.fromEntries(fields.map((f) => [f.name, canonical(f.type)]));
  return usageFromRecords(rows.map((r, i) => ({
    line: i + 1,
    values: {
      account_id: r.account_id === null ? '' : String(r.account_id),
      user_id: r.user_id === null ? '' : String(r.user_id),
      date: r.date === null ? '' : type.date === 'TIMESTAMP' ? isoDay(r.date) : String(r.date),
      domain: r.domain ?? '',
    },
  })));
}
