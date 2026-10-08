// Generates docs/metrics.md and the README metrics table from src/definitions.mjs.
// node scripts/gen.mjs          rewrite them
// node scripts/gen.mjs --check  exit 1 naming each stale file (run by npm test too)
import { readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFINITIONS, PROPERTY_GROUP } from '../src/definitions.mjs';

const TYPE = { number: 'number', date: 'date (YYYY-MM-DD)', string: 'text' };

export function metricsDoc() {
  const parts = [
    '# Metric definitions',
    '',
    '<!-- Generated from src/definitions.mjs by `npm run gen`. Edit the definitions, not this file. -->',
    '',
    `Every value revenue-sync writes to a HubSpot company, in the property group \`${PROPERTY_GROUP.name}\` ("${PROPERTY_GROUP.label}"). Each is computed in exactly one place, src/definitions.mjs, and this page is generated from it.`,
    '',
  ];
  for (const d of DEFINITIONS) {
    parts.push(`## ${d.label}`, '', `Property \`${d.property}\`, ${TYPE[d.type]}${d.money ? ', money (in the billing currency)' : ''}.`, '', d.description, '');
  }
  return parts.join('\n');
}

export function metricsTable() {
  const rows = DEFINITIONS.map((d) => `| \`${d.property}\` | ${d.label} | ${d.description} |`);
  return ['| Property | Metric | Definition |', '|---|---|---|', ...rows].join('\n');
}

const START = '<!-- metrics:start -->';
const END = '<!-- metrics:end -->';

function withTable(readme) {
  const a = readme.indexOf(START);
  const b = readme.indexOf(END);
  if (a < 0 || b < a) return null;
  return `${readme.slice(0, a + START.length)}\n${metricsTable()}\n${readme.slice(b)}`;
}

export function run(root, check) {
  const stale = [];
  const docFile = join(root, 'docs', 'metrics.md');
  const doc = metricsDoc();
  if (!existsSync(docFile) || readFileSync(docFile, 'utf8') !== doc) {
    if (check) stale.push('docs/metrics.md is stale');
    else writeFileSync(docFile, doc);
  }
  const readmeFile = join(root, 'README.md');
  if (existsSync(readmeFile)) {
    const readme = readFileSync(readmeFile, 'utf8');
    const next = withTable(readme);
    if (next !== null && next !== readme) {
      if (check) stale.push('README.md metrics table is stale');
      else writeFileSync(readmeFile, next);
    }
  }
  return stale;
}

// realpath: on macOS the temp folder is a symlink, and a symlinked checkout is common too.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const check = process.argv.includes('--check');
  const stale = run(root, check);
  if (stale.length) {
    process.stderr.write(`${stale.join('\n')}\nRun npm run gen and commit the result with the change that made it stale.\n`);
    process.exit(1);
  }
  process.stdout.write(check ? 'generated files fresh\n' : 'generated files written\n');
}
