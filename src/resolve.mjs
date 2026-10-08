// Resolves every Stripe customer and usage account to exactly one HubSpot company, or refuses.
// Order: an explicit mapping row wins; otherwise a domain match; otherwise unmatched. Two
// companies on one domain, or a mapping file that names two companies, is ambiguous and refused
// with the candidates named. Nothing is ever guessed.

import { companyDomains, emailDomain, isFreemail, normalizeDomain } from './domain.mjs';

export function resolveAccounts({ companies, customers, usageAccounts, mapping }) {
  const byId = new Map(companies.map((c) => [String(c.id), c]));
  const byDomain = new Map();
  for (const c of companies) {
    for (const d of companyDomains(c.properties)) {
      if (!byDomain.has(d)) byDomain.set(d, []);
      if (!byDomain.get(d).includes(c)) byDomain.get(d).push(c);
    }
  }
  const brief = (c) => ({ id: String(c.id), name: c.properties?.name ?? '' });

  const accounts = new Map();
  const unmatched = [];
  const ambiguous = [];

  function attach(companyId, source, sourceId, how) {
    if (!accounts.has(companyId)) {
      const c = byId.get(companyId);
      accounts.set(companyId, { company: { ...brief(c), domain: companyDomains(c.properties)[0] ?? null }, stripe_customer_ids: [], usage_account_ids: [], matched_by: {} });
    }
    const a = accounts.get(companyId);
    (source === 'stripe' ? a.stripe_customer_ids : a.usage_account_ids).push(sourceId);
    a.matched_by[sourceId] = how;
  }

  function place(source, sourceId, label, domain) {
    if (mapping.isConflicted(source, sourceId)) {
      const ids = companies.filter((c) => mapping.candidates?.(source, sourceId)?.includes(String(c.id)));
      ambiguous.push({ source, source_id: sourceId, label, domain, reason: 'the mapping file maps it to more than one HubSpot company', candidates: ids.map(brief) });
      return;
    }
    const mapped = mapping.lookup(source, sourceId);
    if (mapped) {
      if (!byId.has(mapped)) unmatched.push({ source, source_id: sourceId, label, domain, reason: `the mapping file points at HubSpot company ${mapped}, which does not exist` });
      else attach(mapped, source, sourceId, 'mapping');
      return;
    }
    if (!domain) { unmatched.push({ source, source_id: sourceId, label, domain, reason: 'no domain to match on and no mapping row' }); return; }
    if (isFreemail(domain)) { unmatched.push({ source, source_id: sourceId, label, domain, reason: `${domain} is a free mail domain; add a mapping row` }); return; }
    const hits = byDomain.get(domain) ?? [];
    if (!hits.length) unmatched.push({ source, source_id: sourceId, label, domain, reason: `no HubSpot company has the domain ${domain}` });
    else if (hits.length > 1) ambiguous.push({ source, source_id: sourceId, label, domain, reason: `two or more HubSpot companies have the domain ${domain}`, candidates: hits.map(brief) });
    else attach(String(hits[0].id), source, sourceId, 'domain');
  }

  for (const c of customers) {
    const domain = normalizeDomain(c.metadata?.domain) ?? emailDomain(c.email);
    place('stripe', c.id, c.name || c.email || c.id, domain);
  }
  for (const a of usageAccounts.values()) place('usage', a.account_id, a.account_id, a.domain);

  return { accounts, unmatched, ambiguous };
}
