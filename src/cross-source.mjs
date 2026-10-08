// The cross-source check: when billing is read from a warehouse and Stripe is configured too,
// both account models are built from the same HubSpot companies, mapping and usage, and every
// company whose MRR (with its currency) differs between them is named with both values. It is
// separate from the HubSpot comparison and fails reconcile on its own (exit 3).

const SAME = 0.0005; // the tolerance sameValue uses for HubSpot numbers

const value = (a) => (a ? { mrr: a.metrics.mrr, currency: a.metrics.currency } : null);

function agree(w, s) {
  if (!w || !s) return (w ?? s).mrr === 0;
  if (Math.abs((w.mrr ?? 0) - (s.mrr ?? 0)) >= SAME) return false;
  return w.mrr === 0 || w.currency === s.currency;
}

export function compareSources({ warehouse, stripe }) {
  const byId = (m) => new Map(m.accounts.map((a) => [a.hubspot_company_id, a]));
  const W = byId(warehouse);
  const S = byId(stripe);
  const ids = [...new Set([...W.keys(), ...S.keys()])];
  const disagreements = [];
  const notCompared = [];
  let compared = 0;
  for (const id of ids) {
    const w = W.get(id);
    const s = S.get(id);
    const name = (w ?? s).hubspot_company_name;
    const flagged = [[w, 'the warehouse'], [s, 'Stripe']].find(([a]) => a?.blocked.includes('mrr'));
    if (flagged) {
      notCompared.push({ company_id: id, company_name: name, reason: `flagged in ${flagged[1]}: ${flagged[0].flags.map((f) => f.detail).join('; ')}` });
      continue;
    }
    compared++;
    if (!agree(value(w), value(s))) disagreements.push({ company_id: id, company_name: name, warehouse: value(w), stripe: value(s) });
  }
  // Nothing compared is never agreement: a check that saw no company cannot say the sources agree.
  return { ok: !disagreements.length && compared > 0, disagreements, notCompared, compared, total: ids.length };
}

const say = (v) => `${v.mrr ?? 0}${v.currency ? ` ${v.currency}` : ''}`;
const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export function formatCrossSource(r) {
  const lines = [];
  if (r.disagreements.length) lines.push(`Warehouse and Stripe disagree on MRR for ${n(r.disagreements.length, 'company', 'companies')}.`, '');
  for (const d of r.disagreements) {
    lines.push(`${d.company_name} (HubSpot ${d.company_id}): ${d.warehouse ? `warehouse says ${say(d.warehouse)}` : 'warehouse has no record'}, ${d.stripe ? `Stripe says ${say(d.stripe)}` : 'Stripe has no record'}`);
  }
  for (const x of r.notCompared) lines.push(`Not compared: ${x.company_name} (HubSpot ${x.company_id}): ${x.reason}`);
  if (r.disagreements.length) {
    lines.push('', 'Cross-source check failed: the warehouse billing data and Stripe disagree. A warehouse load behind Stripe (Stripe Data Pipeline loads every 3 hours) is the usual cause; if it persists, check the billing SQL.');
  } else if (r.compared === 0) {
    if (lines.length) lines.push('');
    lines.push(r.total
      ? `Cross-source check compared nothing: every company is flagged on one side or the other (${r.notCompared.length} listed above), so the warehouse and Stripe were not shown to agree.`
      : 'Cross-source check compared nothing: neither source has a company that resolves to HubSpot, so the warehouse and Stripe were not shown to agree.');
  } else {
    if (lines.length) lines.push('');
    lines.push(`Warehouse and Stripe agree on MRR: ${r.compared} of ${n(r.total, 'company', 'companies')} compared.`);
  }
  return `${lines.join('\n')}\n`;
}
