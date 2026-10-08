// The plan: every HubSpot write needed to make each company's revenue-sync properties match the
// account model. Desired values are compared with the LIVE HubSpot values, so a re-run after a
// sync plans nothing and a hand edit is corrected; the last synced snapshot is the witness that
// marks a hand edit so it is never overwritten silently.

import { PROPERTY_GROUP, scopedDefinitions, unlinkedValue } from './definitions.mjs';

export function toHubSpot(def, value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

const blank = (v) => v === null || v === undefined || String(v).trim() === '';

function asDate(v) {
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return new Date(Number(s)).toISOString().slice(0, 10);
  return s.slice(0, 10);
}

export function sameValue(def, a, b) {
  if (blank(a) || blank(b)) return blank(a) && blank(b);
  if (def.type === 'number') return Math.abs(Number(a) - Number(b)) < 0.0005;
  if (def.type === 'date') return asDate(a) === asDate(b);
  return String(a).trim() === String(b).trim();
}

export function planWrites({ model, current, snapshot = null }) {
  const writes = [];
  const missing_companies = [];
  for (const a of model.accounts) {
    const props = current.get(a.hubspot_company_id);
    if (!props) { missing_companies.push(a.hubspot_company_id); continue; }
    const synced = snapshot?.values?.[a.hubspot_company_id] ?? {};
    for (const def of scopedDefinitions(model)) {
      if (a.blocked.includes(def.key)) continue;
      const desired = toHubSpot(def, a.metrics[def.key]);
      const old = blank(props[def.property]) ? '' : String(props[def.property]);
      if (sameValue(def, old, desired)) continue;
      const edited = def.property in synced && !sameValue(def, synced[def.property], old);
      writes.push({ company_id: a.hubspot_company_id, company_name: a.hubspot_company_name, key: def.key, property: def.property, old, new: desired, edited_since_sync: edited });
    }
  }
  for (const u of model.unlinked ?? []) {
    if (u.held) continue;
    const props = current.get(u.hubspot_company_id);
    if (!props) continue;
    for (const def of scopedDefinitions(model)) {
      const desired = unlinkedValue(def);
      const old = blank(props[def.property]) ? '' : String(props[def.property]);
      if (sameValue(def, old, desired)) continue;
      writes.push({ company_id: u.hubspot_company_id, company_name: u.hubspot_company_name, key: def.key, property: def.property, old, new: desired, edited_since_sync: false, unlinked: true });
    }
  }
  return { writes, missing_companies };
}


export function formatPlan(plan, { missingProperties = [], missingGroup = false, verb = 'Would create' } = {}) {
  const lines = [];
  if (missingProperties.length) {
    const group = missingGroup ? `the property group ${PROPERTY_GROUP.name} and ` : '';
    lines.push(`${verb} ${group}${missingProperties.length} ${missingProperties.length === 1 ? 'property' : 'properties'}: ${missingProperties.join(', ')}`, '');
  }
  const byCompany = new Map();
  for (const w of plan.writes) {
    if (!byCompany.has(w.company_id)) byCompany.set(w.company_id, []);
    byCompany.get(w.company_id).push(w);
  }
  for (const [id, ws] of byCompany) {
    lines.push(`${ws[0].company_name} (HubSpot ${id})`);
    for (const w of ws) lines.push(`  ${w.property}: ${w.old === '' ? '(empty)' : w.old} → ${w.new === '' ? '(empty)' : w.new}${w.edited_since_sync ? ' (edited in HubSpot since the last sync)' : ''}`);
    lines.push('');
  }
  for (const id of plan.missing_companies) lines.push(`Skipped HubSpot company ${id}: it was not found when its current values were read (deleted or merged?).`);
  if (!plan.writes.length) lines.push('Nothing to write: HubSpot already matches billing and usage.');
  else lines.push(`${plan.writes.length} ${plan.writes.length === 1 ? 'write' : 'writes'} across ${byCompany.size} ${byCompany.size === 1 ? 'company' : 'companies'}.`);
  return `${lines.join('\n')}\n`;
}
