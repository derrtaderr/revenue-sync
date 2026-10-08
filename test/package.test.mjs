import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the package ships what a user runs and reads, and nothing else', () => {
  const r = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const files = JSON.parse(r.stdout)[0].files.map((f) => f.path).sort();
  for (const f of files) assert.match(f, /^(bin\/|src\/|schema\/|examples\/bigquery\/[\w-]+\.sql$|docs\/account-model\.md$|docs\/metrics\.md$|docs\/warehouse\.md$|README\.md$|LICENSE$|package\.json$)/, `${f} should not ship`);
  for (const f of ['bin/revenue-sync.mjs', 'src/definitions.mjs', 'schema/account-model.v1.json', 'docs/account-model.md', 'docs/warehouse.md', 'examples/bigquery/demo-billing.sql', 'examples/bigquery/stripe-data-pipeline-billing.sql', 'LICENSE']) assert.ok(files.includes(f), f);
});

test('zero runtime dependencies and a bin entry', () => {
  assert.deepEqual(PKG.dependencies ?? {}, {});
  assert.equal(PKG.bin['revenue-sync'], 'bin/revenue-sync.mjs');
});

test('npm test runs only the test files, not the helpers next to them', () => {
  assert.equal(PKG.scripts.test, 'node --test test/*.test.mjs');
});

test('engines asks for Node 20.6, which --env-file needs (m2)', () => {
  assert.equal(PKG.engines.node, '>=20.6');
});
