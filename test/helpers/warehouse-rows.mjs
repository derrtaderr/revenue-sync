// The warehouse row contract (docs/warehouse.md) built from the fake Stripe database, so a test
// can feed the SAME billing data through the Stripe path and the warehouse path and compare the
// account models. This is what a correct --billing-sql produces for that Stripe account.
import { BILLING_COLUMNS } from '../../src/warehouse.mjs';

// The canonical BigQuery type for each contract column.
export function billingFields() {
  return BILLING_COLUMNS.map((c) => ({ name: c.name, type: c.types[0], mode: 'NULLABLE' }));
}

const blank = () => Object.fromEntries(BILLING_COLUMNS.map((c) => [c.name, null]));
const row = (values) => ({ ...blank(), ...values });

export function rowsFromStripe(db) {
  const rows = [];
  for (const c of db.customers) {
    rows.push(row({ record: 'customer', customer_id: c.id, customer_name: c.name, customer_email: c.email, customer_domain: c.metadata?.domain ?? null, customer_discount: !!c.discount }));
  }
  for (const s of db.subscriptions) {
    rows.push(row({ record: 'subscription', customer_id: s.customer, subscription_id: s.id, status: s.status, currency: s.currency, cancel_at_period_end: s.cancel_at_period_end, cancel_at: s.cancel_at, collection_paused: !!s.pause_collection }));
    for (const it of s.items.data) {
      const p = it.price;
      rows.push(row({
        record: 'item', subscription_id: s.id, item_id: it.id, price_id: p.id, product_id: p.product, product_name: db.products.find((x) => x.id === p.product)?.name ?? null,
        price_nickname: p.nickname, unit_amount: p.unit_amount_decimal ?? (p.unit_amount == null ? null : String(p.unit_amount)), billing_interval: p.recurring.interval, interval_count: p.recurring.interval_count,
        usage_type: p.recurring.usage_type, billing_scheme: p.billing_scheme, tax_behavior: p.tax_behavior, transform_divide_by: p.transform_quantity?.divide_by ?? null, transform_round: p.transform_quantity?.round ?? null,
        quantity: it.quantity, current_period_end: it.current_period_end, item_discounted: !!it.discounts?.length,
      }));
    }
    for (const id of s.discounts) {
      const d = db.discounts.find((x) => x.id === id);
      const c = db.coupons.find((x) => x.id === d.source.coupon);
      rows.push(row({ record: 'discount', subscription_id: s.id, discount_id: d.id, coupon_id: c.id, percent_off: c.percent_off == null ? null : String(c.percent_off), amount_off: c.amount_off == null ? null : String(c.amount_off), currency: c.currency, duration: c.duration, discount_end: d.end, applies_to: c.applies_to?.products ? c.applies_to.products.join(',') : '' }));
    }
  }
  for (const i of db.invoices.filter((x) => x.status === 'open')) rows.push(row({ record: 'open_invoice', customer_id: i.customer, invoice_id: i.id, currency: i.currency, amount_remaining: String(i.amount_remaining) }));
  return rows;
}

// Decoded rows (what src/bigquery.mjs returns) to BigQuery's wire form, for the fake BigQuery:
// INT64, NUMERIC and TIMESTAMP as strings, BOOL as "true"/"false", NULL as null.
export function toWire(fields, rows) {
  return rows.map((r) => fields.map((f) => {
    const v = r[f.name];
    if (v === null || v === undefined) return null;
    if (f.type === 'BOOL') return v ? 'true' : 'false';
    if (f.type === 'TIMESTAMP') return Number(v).toExponential();
    return String(v);
  }));
}
