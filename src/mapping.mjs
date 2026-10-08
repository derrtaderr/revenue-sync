// The explicit mapping file: source,source_id,hubspot_company_id. One row says "this Stripe
// customer (or usage account) is this HubSpot company". It overrides domain matching.

import { parseCsv } from './csv.mjs';

export const MAPPING_COLUMNS = ['source', 'source_id', 'hubspot_company_id'];
export const SOURCES = ['stripe', 'usage'];

export function parseMapping(text) {
  const targets = new Map();
  const problems = [];
  const rows = [];
  if (text != null) {
    const csv = parseCsv(text);
    const missing = MAPPING_COLUMNS.filter((c) => !csv.header.includes(c));
    if (missing.length) throw new Error(`The mapping CSV needs the columns ${MAPPING_COLUMNS.join(', ')}. Missing: ${missing.join(', ')}.`);
    problems.push(...csv.problems);
    for (const { line, values } of csv.rows) {
      const source = values.source.toLowerCase();
      if (!SOURCES.includes(source)) { problems.push({ line, reason: `source must be stripe or usage, got ${JSON.stringify(values.source)}` }); continue; }
      if (!values.source_id) { problems.push({ line, reason: 'has no source_id' }); continue; }
      if (!/^\d+$/.test(values.hubspot_company_id)) { problems.push({ line, reason: `hubspot_company_id must be the numeric HubSpot record id, got ${JSON.stringify(values.hubspot_company_id)}` }); continue; }
      rows.push({ line, source, source_id: values.source_id });
      const key = `${source}:${values.source_id}`;
      if (!targets.has(key)) targets.set(key, { source, source_id: values.source_id, company_ids: [] });
      const t = targets.get(key);
      if (!t.company_ids.includes(values.hubspot_company_id)) t.company_ids.push(values.hubspot_company_id);
    }
  }
  problems.sort((a, b) => a.line - b.line);
  const conflicts = [...targets.values()].filter((t) => t.company_ids.length > 1);
  return {
    problems,
    conflicts,
    rows,
    lookup(source, id) {
      const t = targets.get(`${source}:${id}`);
      return t && t.company_ids.length === 1 ? t.company_ids[0] : null;
    },
    isConflicted: (source, id) => (targets.get(`${source}:${id}`)?.company_ids.length ?? 0) > 1,
    candidates: (source, id) => targets.get(`${source}:${id}`)?.company_ids ?? [],
  };
}
