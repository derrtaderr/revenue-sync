// The account model: one record per HubSpot company with its billing and usage sources and
// every metric from src/definitions.mjs, plus everything that was refused and why. This is the
// product's contract with later tools (see docs/account-model.md and
// schema/account-model.v1.json). A change to its shape bumps MODEL_VERSION.

import { resolveAccounts } from './resolve.mjs';
import { computeAccount, DEFINITIONS, scopedDefinitions, unlinkedValue } from './definitions.mjs';

export const MODEL_SCHEMA = 'revenue-sync.account-model';
export const MODEL_VERSION = 1;

const groupBy = (list, key) => {
  const m = new Map();
  for (const x of list) {
    const k = x[key];
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

export function buildModel({ companies, customers, subscriptions, invoices, products, coupons = null, usage, mapping, asOf, generatedAt }) {
  const usageAccounts = usage?.accounts ?? new Map();
  const resolved = resolveAccounts({ companies, customers, usageAccounts, mapping });
  const subsBy = groupBy(subscriptions, 'customer');
  const invBy = groupBy(invoices, 'customer');

  const accounts = [...resolved.accounts.entries()].map(([id, a]) => {
    const events = usage && a.usage_account_ids.length ? a.usage_account_ids.flatMap((u) => usageAccounts.get(u).events) : null;
    const { metrics, flags } = computeAccount({
      subscriptions: a.stripe_customer_ids.flatMap((c) => subsBy.get(c) ?? []),
      invoices: a.stripe_customer_ids.flatMap((c) => invBy.get(c) ?? []),
      products,
      coupons,
      customers: customers.filter((c) => a.stripe_customer_ids.includes(c.id)),
      usage: events,
      asOf,
    });
    const blocked = flags.length ? DEFINITIONS.filter((d) => d.money).map((d) => d.key) : [];
    return {
      hubspot_company_id: id,
      hubspot_company_name: a.company.name,
      domain: a.company.domain,
      stripe_customer_ids: a.stripe_customer_ids,
      usage_account_ids: a.usage_account_ids,
      matched_by: a.matched_by,
      metrics,
      blocked,
      flags,
    };
  });
  accounts.sort((x, y) => x.hubspot_company_name.localeCompare(y.hubspot_company_name) || x.hubspot_company_id.localeCompare(y.hubspot_company_id));

  const scoped = scopedDefinitions({ sources: { usage: { provided: !!usage } } });
  const linked = new Set(accounts.map((a) => a.hubspot_company_id));
  const blank = (v) => v === null || v === undefined || String(v).trim() === '';
  const unlinked = companies
    .filter((c) => !linked.has(String(c.id)) && scoped.some((d) => !blank(c.properties?.[d.property])))
    .map((c) => {
      const amb = resolved.ambiguous.find((x) => x.candidates.some((k) => k.id === String(c.id)));
      return {
        hubspot_company_id: String(c.id),
        hubspot_company_name: c.properties?.name ?? '',
        reason: amb
          ? `a record that matched it is now ambiguous (${amb.source} ${amb.source_id}: ${amb.reason})`
          : 'no Stripe customer or usage account resolves to it any more',
        cleared: scoped.every((d) => String(c.properties?.[d.property] ?? '').trim() === unlinkedValue(d)),
      };
    })
    .sort((x, y) => x.hubspot_company_name.localeCompare(y.hubspot_company_name));

  // A subscription or open invoice with no customer id (Stripe Accounts v2 bills an account via
  // customer_account) cannot be attributed by a tool that reads v1 customers. Reported, never
  // silently dropped (m13).
  const orphans = [
    ...subscriptions.filter((x) => !['canceled', 'incomplete_expired'].includes(x.status)).map((x) => ['subscription', x]),
    ...invoices.map((x) => ['open invoice', x]),
  ].filter(([, x]) => typeof x.customer !== 'string' || !x.customer).map(([kind, x]) => ({
    source: 'stripe',
    source_id: x.id,
    label: `${kind} ${x.id}`,
    domain: null,
    reason: typeof x.customer_account === 'string'
      ? `billed to a Stripe Accounts v2 customer account ${x.customer_account}; this tool reads v1 customers, so it cannot be attributed to a company`
      : 'has no customer id, so it cannot be attributed to a company',
  }));

  // A mapping row whose source record is not there (a mistyped cus_ id, a retired usage account)
  // is reported, not silently ignored (pre-public review m-i). Usage rows are checked only when usage was read.
  const customerIds = new Set(customers.map((c) => c.id));
  const unknownRows = (mapping?.rows ?? []).filter((r) => (r.source === 'stripe' ? !customerIds.has(r.source_id) : usage && !usageAccounts.has(r.source_id))).map((r) => ({
    line: r.line,
    reason: r.source === 'stripe' ? `stripe customer ${r.source_id} is not in this Stripe account` : `usage account ${r.source_id} is not in the usage file`,
  }));

  return {
    schema: MODEL_SCHEMA,
    version: MODEL_VERSION,
    generated_at: generatedAt.toISOString(),
    as_of: asOf,
    sources: {
      stripe: { customers: customers.length, subscriptions: subscriptions.length, open_invoices: invoices.length },
      usage: { accounts: usageAccounts.size, provided: !!usage },
      mapping: { provided: !!mapping?.provided },
      hubspot: { companies: companies.length },
    },
    accounts,
    unlinked,
    unmatched: [...resolved.unmatched, ...orphans],
    ambiguous: resolved.ambiguous,
    input_problems: [
      ...(usage?.problems ?? []).map((p) => ({ file: 'usage', ...p })),
      ...[...(mapping?.problems ?? []), ...unknownRows].sort((a, b) => a.line - b.line).map((p) => ({ file: 'mapping', ...p })),
    ],
  };
}
