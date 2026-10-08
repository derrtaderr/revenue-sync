// A small RFC 4180 reader: quoted fields, embedded commas and newlines, doubled quotes, CRLF,
// a leading byte order mark. Rows with the wrong field count are reported with their line
// number rather than padded or truncated.

function records(text) {
  const out = [];
  let field = '';
  let row = [];
  let line = 1;
  let rowLine = 1;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false;
      else { if (ch === '\n') line++; field += ch; }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      out.push({ line: rowLine, fields: row });
      row = []; field = ''; line++; rowLine = line;
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); out.push({ line: rowLine, fields: row }); }
  return out.filter((r) => !(r.fields.length === 1 && r.fields[0].trim() === ''));
}

export function parseCsv(text) {
  const all = records(String(text ?? '').replace(/^﻿/, ''));
  if (!all.length) return { header: [], rows: [], problems: [] };
  const header = all[0].fields.map((h) => h.trim().toLowerCase());
  const rows = [];
  const problems = [];
  for (const r of all.slice(1)) {
    if (r.fields.length !== header.length) {
      problems.push({ line: r.line, reason: `has ${r.fields.length} fields, the header has ${header.length}` });
      continue;
    }
    rows.push({ line: r.line, values: Object.fromEntries(header.map((h, i) => [h, r.fields[i].trim()])) });
  }
  return { header, rows, problems };
}
