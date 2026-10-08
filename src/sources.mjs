// Sources. A billing source returns { customers, subscriptions, invoices, products, coupons } in
// the shape src/definitions.mjs reads (the Stripe API shape), plus identity() for the unlink
// guard. A usage source returns { accounts, problems }, the shape the usage CSV reader returns.
// Resolution, definitions, plan, sync, reconcile, the journal and the unlink guard never see
// which source ran (docs/SPEC.md, "Warehouse sources").

import { createHash } from 'node:crypto';
import { parseUsage } from './usage.mjs';
import { billingFromRows, usageFromRows } from './warehouse.mjs';

export function createStripeBillingSource({ client }) {
  return {
    kind: 'stripe',
    async read() {
      const customers = await client.listCustomers();
      const subscriptions = await client.listSubscriptions();
      const invoices = await client.listOpenInvoices();
      const products = await client.listProducts();
      const coupons = await client.listCoupons();
      return { customers, subscriptions, invoices, products: new Map(products.map((p) => [p.id, p])), coupons: new Map(coupons.map((c) => [c.id, c])) };
    },
    async identity() {
      return { ...(await client.accountId()), label: 'Stripe account' };
    },
  };
}

// The CSV is parsed when the source is created, so a bad file stops the run before any request.
export function createCsvUsageSource({ text }) {
  const parsed = parseUsage(text);
  return { kind: 'csv', read: async () => parsed };
}

// A billing source over a warehouse query (docs/warehouse.md). Its identity for the unlink guard
// is the project plus a hash of the SQL text: another project, another query or another source
// reads as a different billing source, so unlinks are held until --allow-unlink.
export function createWarehouseBillingSource({ client, sql, project, where }) {
  return {
    kind: 'bigquery',
    async read() {
      const { fields, rows } = await client.query(sql);
      return billingFromRows({ fields, rows, where });
    },
    async identity() {
      return { id: `bigquery:${project}:${createHash('sha256').update(sql).digest('hex').slice(0, 16)}`, label: 'billing source' };
    },
  };
}

export function createWarehouseUsageSource({ client, sql, where }) {
  return {
    kind: 'bigquery',
    async read() {
      const { fields, rows } = await client.query(sql);
      return usageFromRows({ fields, rows, where });
    },
  };
}
