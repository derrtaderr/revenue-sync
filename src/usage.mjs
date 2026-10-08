// Product usage from a CSV: one row per user activity (a login, an event, a day active).
// Columns: account_id, user_id, date (YYYY-MM-DD or an ISO timestamp), and optionally domain.

import { parseCsv } from './csv.mjs';
import { normalizeDomain } from './domain.mjs';

export const USAGE_COLUMNS = ['account_id', 'user_id', 'date'];

export function validDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value ?? '');
  if (!m) return null;
  const d = `${m[1]}-${m[2]}-${m[3]}`;
  const t = new Date(`${d}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === d ? d : null;
}

export function parseUsage(text) {
  const csv = parseCsv(text);
  const missing = USAGE_COLUMNS.filter((c) => !csv.header.includes(c));
  if (missing.length) throw new Error(`The usage CSV needs the columns ${USAGE_COLUMNS.join(', ')} (domain is optional). Missing: ${missing.join(', ')}.`);
  const r = usageFromRecords(csv.rows);
  const problems = [...csv.problems, ...r.problems].sort((a, b) => a.line - b.line);
  return { accounts: r.accounts, problems };
}

// One validation for usage rows from any source: { line, values: { account_id, user_id, date,
// domain } } with string values. A CSV line and a warehouse row are skipped for the same reasons.
export function usageFromRecords(records) {
  const accounts = new Map();
  const problems = [];
  for (const { line, values } of records) {
    const { account_id: account, user_id: user } = values;
    const date = validDate(values.date);
    if (!account) { problems.push({ line, reason: 'has no account_id' }); continue; }
    if (!user) { problems.push({ line, reason: 'has no user_id' }); continue; }
    if (!date) { problems.push({ line, reason: `has a date that is not YYYY-MM-DD: ${JSON.stringify(values.date)}` }); continue; }
    if (!accounts.has(account)) accounts.set(account, { account_id: account, domain: null, events: [] });
    const a = accounts.get(account);
    const domain = normalizeDomain(values.domain);
    if (domain && !a.domain) a.domain = domain;
    else if (domain && domain !== a.domain) problems.push({ line, reason: `names domain ${domain} but ${account} already has domain ${a.domain}` });
    a.events.push({ user_id: user, date });
  }
  problems.sort((a, b) => a.line - b.line);
  return { accounts, problems };
}
