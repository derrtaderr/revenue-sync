// Reads examples/bigquery/demo-billing.sql the way BigQuery would for this one constrained shape
// (literal STRUCT arrays in CTEs, then `SELECT blank.* REPLACE (expr AS column, ...)` per record
// kind), so a test can feed the demo's own literals and its own column mapping through the fake
// BigQuery. It understands only what the demo uses: string, NUMERIC, integer, boolean and NULL
// literals, CAST(NULL AS T), and TIMESTAMP(DATE_ADD(CURRENT_DATE(), INTERVAL n MONTH|DAY)).

function splitTop(text) {
  const out = [];
  let depth = 0; let quoted = false; let cur = '';
  for (const ch of text) {
    if (ch === "'" ) quoted = !quoted;
    if (!quoted && (ch === '(' || ch === '[')) depth++;
    if (!quoted && (ch === ')' || ch === ']')) depth--;
    if (!quoted && depth === 0 && ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function literal(expr, nowMs) {
  const e = expr.trim();
  let m;
  if (/^(CAST\(NULL AS \w+\)|NULL)$/.test(e)) return null;
  if (e === 'TRUE' || e === 'FALSE') return e === 'TRUE';
  if ((m = /^NUMERIC '(-?[\d.]+)'$/.exec(e))) return m[1];
  if ((m = /^'((?:[^']|'')*)'$/.exec(e))) return m[1];
  if (/^-?\d+$/.test(e)) return e;
  if ((m = /^TIMESTAMP\(DATE_ADD\(CURRENT_DATE\(\), INTERVAL (\d+) (MONTH|DAY)\)\)$/.exec(e))) {
    const d = new Date(nowMs);
    const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    if (m[2] === 'MONTH') day.setUTCMonth(day.getUTCMonth() + Number(m[1])); else day.setUTCDate(day.getUTCDate() + Number(m[1]));
    return day.getTime() / 1000;
  }
  throw new Error(`demo-sql helper cannot read ${e}`);
}

export function demoBillingRows(sql, nowMs) {
  const fields = [...sql.slice(sql.indexOf('blank AS ('), sql.indexOf('customers AS (')).matchAll(/CAST\(NULL AS (\w+)\) AS (\w+)/g)].map(([, type, name]) => ({ name, type, mode: 'NULLABLE' }));
  const ctes = {};
  for (const name of ['customers', 'subscriptions', 'items', 'discounts', 'open_invoices']) {
    const start = sql.indexOf(`${name} AS (`);
    const block = sql.slice(sql.indexOf('UNNEST([', start) + 'UNNEST(['.length, sql.indexOf('\n    ])', start));
    const tuples = splitTop(block).map((t) => t.replace(/^STRUCT/, '').replace(/^\(|\)$/g, ''));
    const names = splitTop(tuples[0]).map((p) => /\bAS (\w+)$/.exec(p)[1]);
    ctes[name] = tuples.map((t, i) => Object.fromEntries(splitTop(t).map((v, j) => [names[j], literal(i === 0 ? v.replace(/\s+AS \w+$/, '') : v, nowMs)])));
  }
  const rows = [];
  for (const [, list, cte, alias] of sql.matchAll(/SELECT blank\.\* REPLACE \(([\s\S]*?)\)\s*FROM blank CROSS JOIN (\w+) AS (\w+)/g)) {
    const pairs = splitTop(list).map((p) => /^([\s\S]+?)\s+AS (\w+)$/.exec(p.trim()).slice(1));
    for (const src of ctes[cte]) {
      const row = Object.fromEntries(fields.map((f) => [f.name, null]));
      for (const [expr, col] of pairs) row[col] = expr.startsWith(`${alias}.`) ? src[expr.slice(alias.length + 1)] : literal(expr, nowMs);
      rows.push(row);
    }
  }
  return { fields, rows };
}
