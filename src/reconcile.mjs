// reconcile: re-read HubSpot and compare every revenue-sync property with what billing and usage
// say right now. Any disagreement fails the check (exit 3) with both values. This is the part of
// the tool that can say "no".

import { DEFINITIONS, scopedDefinitions, unlinkedValue } from './definitions.mjs';
import { sameValue, toHubSpot } from './plan.mjs';

// A skipped input row, named for where it came from: a CSV line, or a row of the usage query.
export const problemLabel = (p, usageSource) => (p.file === 'usage' && usageSource === 'bigquery' ? `usage query row ${p.line}` : `${p.file} CSV line ${p.line}`);

const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const show = (v) => (blank(v) ? '(empty)' : String(v));
const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export function reconcile({ model, current, strict = false }) {
  const disagreements = [];
  const missing = [];
  let values = 0;
  let companies = 0;
  for (const a of model.accounts) {
    const props = current.get(a.hubspot_company_id);
    if (!props) { missing.push(a); continue; }
    companies++;
    for (const d of scopedDefinitions(model)) {
      if (a.blocked.includes(d.key)) continue;
      values++;
      const billing = toHubSpot(d, a.metrics[d.key]);
      const crm = blank(props[d.property]) ? '' : String(props[d.property]);
      if (!sameValue(d, crm, billing)) disagreements.push({ company_id: a.hubspot_company_id, company_name: a.hubspot_company_name, key: d.key, property: d.property, label: d.label, crm, billing });
    }
  }
  const unlinkedCleared = [];
  const held = (model.unlinked ?? []).filter((u) => u.held);
  for (const u of model.unlinked ?? []) {
    if (u.held) continue;
    const props = current.get(u.hubspot_company_id);
    if (!props) continue;
    let stale = false;
    for (const d of scopedDefinitions(model)) {
      const billing = unlinkedValue(d);
      const crm = blank(props[d.property]) ? '' : String(props[d.property]);
      if (!sameValue(d, crm, billing)) {
        stale = true;
        disagreements.push({ company_id: u.hubspot_company_id, company_name: u.hubspot_company_name, key: d.key, property: d.property, label: d.label, crm, billing, unlinked_reason: u.reason });
      }
    }
    if (!stale) unlinkedCleared.push(u);
  }
  const flagged = model.accounts.filter((a) => a.blocked.length);
  const refusedCount = held.length + unlinkedCleared.length + model.unmatched.length + model.ambiguous.length + flagged.length + (model.input_problems?.length ?? 0);
  const ok = !disagreements.length && !missing.length && (!strict || refusedCount === 0);
  return { ok, strict, billingSource: model.sources?.billing?.source ?? 'stripe', usageSource: model.sources?.usage?.source ?? null, guard: model.unlink_guard ?? null, held, unlinkedCleared, usageSkipped: model.sources?.usage?.provided === false, disagreements, missing, flagged, unmatched: model.unmatched, ambiguous: model.ambiguous, input_problems: model.input_problems ?? [], checked: { companies, values } };
}

const LABEL = new Map(DEFINITIONS.map((d) => [d.key, d.label]));
const USAGE_KEYS = new Set(DEFINITIONS.filter((d) => d.usage).map((d) => d.key));

export function formatReconcile(r, { missingMapping = false } = {}) {
  const lines = [];
  if (r.disagreements.length) {
    const byCompany = new Map();
    for (const d of r.disagreements) {
      if (!byCompany.has(d.company_id)) byCompany.set(d.company_id, []);
      byCompany.get(d.company_id).push(d);
    }
    lines.push(`${n(r.disagreements.length, 'value disagrees', 'values disagree')} across ${n(byCompany.size, 'company', 'companies')}.`, '');
    for (const [id, ds] of byCompany) {
      lines.push(`${ds[0].company_name} (HubSpot ${id})${ds[0].unlinked_reason ? `, no longer linked: ${ds[0].unlinked_reason}` : ''}`);
      for (const d of ds) lines.push(`  ${d.label} (${d.property}): HubSpot says ${show(d.crm)}, ${USAGE_KEYS.has(d.key) ? 'usage' : 'billing'} says ${show(d.billing)}`);
      lines.push('');
    }
  }
  for (const a of r.missing) lines.push(`${a.hubspot_company_name} (HubSpot ${a.hubspot_company_id}) is in the account model but HubSpot no longer has it.`);
  for (const u of r.held ?? []) lines.push(`Held, not unlinked: ${u.hubspot_company_name} (HubSpot ${u.hubspot_company_id}): ${u.held}`);
  for (const u of r.unlinkedCleared) lines.push(`Unlinked, values cleared: ${u.hubspot_company_name} (HubSpot ${u.hubspot_company_id}): ${u.reason}`);
  for (const a of r.flagged) lines.push(`Not checked: ${a.hubspot_company_name} (HubSpot ${a.hubspot_company_id}) ${a.blocked.map((k) => LABEL.get(k)).join(', ')}: ${a.flags.map((f) => f.detail).join('; ')}`);
  for (const u of r.unmatched) lines.push(`Refused, never written: ${u.source} ${u.source_id} (${u.label}): ${u.reason}`);
  for (const u of r.ambiguous) lines.push(`Refused, never written: ${u.source} ${u.source_id} (${u.label}): matches ${u.candidates.map((c) => `${c.name} (${c.id})`).join(' and ')}; add a mapping row`);
  for (const p of r.input_problems) lines.push(`Skipped ${problemLabel(p, r.usageSource)}: ${p.reason}`);
  if (r.usageSkipped) lines.push('Usage values were not checked: no usage source was given (--usage or --usage-sql).');
  if (lines.length && lines.at(-1) !== '') lines.push('');
  const notChecked = [
    r.flagged.length && n(r.flagged.length, 'flagged company', 'flagged companies'),
    r.held?.length && n(r.held.length, 'held company', 'held companies'),
    r.unlinkedCleared.length && n(r.unlinkedCleared.length, 'unlinked company', 'unlinked companies'),
    r.unmatched.length && n(r.unmatched.length, 'unmatched record', 'unmatched records'),
    r.ambiguous.length && n(r.ambiguous.length, 'ambiguous record', 'ambiguous records'),
    r.input_problems.length && n(r.input_problems.length, 'skipped CSV row', 'skipped CSV rows'),
    r.usageSkipped && 'usage values',
  ].filter(Boolean);
  const counts = `${n(r.checked.companies, 'company', 'companies')}, ${n(r.checked.values, 'value', 'values')}`;
  if (r.ok && !notChecked.length) {
    lines.push(`Reconciled: ${counts}. HubSpot agrees with billing and usage.`);
  } else if (r.ok) {
    lines.push(`Checked values agree: ${counts}. Not checked: ${notChecked.join(', ')}. Exit 0; --strict makes these fail.`);
  } else if (!r.disagreements.length && !r.missing.length) {
    lines.push('Every compared value agrees, but --strict also fails on refused, flagged or skipped records (listed above).');
  } else if (missingMapping) {
    // plan and sync without --mapping cannot fix this (sync refuses), so do not send users there.
    lines.push('Reconcile failed, but this run has no --mapping and the last sync used one, so the mapped values above read as disagreements. Run reconcile again with the same --mapping file.');
  } else if (r.guard && !r.guard.ok) {
    lines.push(`Reconcile failed, and sync is refusing this run (unlink guard: ${r.guard.reason}), so plan and sync alone will not fix it. ${r.billingSource === 'bigquery' ? 'Check that the billing SQL and BigQuery project are the ones this portal was synced from' : 'Check that STRIPE_API_KEY is the account this portal was synced from'} and that the mapping and usage files were passed; if the companies really are gone, run sync --allow-unlink.`);
  } else {
    lines.push('Reconcile failed. Run plan to see the writes that would fix this, then sync.');
  }
  return `${lines.join('\n')}\n`;
}
