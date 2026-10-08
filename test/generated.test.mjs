import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metricsDoc, metricsTable } from '../scripts/gen.mjs';
import { DEFINITIONS } from '../src/definitions.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GEN = join(ROOT, 'scripts', 'gen.mjs');

test('docs/metrics.md and the README metrics table are fresh (npm run gen:check)', () => {
  const r = spawnSync(process.execPath, [GEN, '--check'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('the metrics doc carries every definition: property, type and the plain-words meaning', () => {
  const doc = metricsDoc();
  for (const d of DEFINITIONS) {
    assert.ok(doc.includes(`\`${d.property}\``), d.property);
    assert.ok(doc.includes(d.description), d.key);
  }
  assert.match(doc, /Generated from src\/definitions\.mjs/);
});

test('the README table has one row per definition', () => {
  const rows = metricsTable().split('\n').filter((l) => l.startsWith('| `rs_'));
  assert.equal(rows.length, DEFINITIONS.length);
});

test('the check fails when a generated file is stale, and names it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rs-gen-'));
  for (const d of ['scripts', 'src']) cpSync(join(ROOT, d), join(dir, d), { recursive: true });
  mkdirSync(join(dir, 'docs'));
  writeFileSync(join(dir, 'docs', 'metrics.md'), 'stale\n');
  writeFileSync(join(dir, 'README.md'), '<!-- metrics:start -->\nold\n<!-- metrics:end -->\n');
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'gen.mjs'), '--check'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /docs\/metrics\.md is stale/);
  assert.match(r.stderr, /README\.md metrics table is stale/);
  const w = spawnSync(process.execPath, [join(dir, 'scripts', 'gen.mjs')], { cwd: dir, encoding: 'utf8' });
  assert.equal(w.status, 0, w.stderr);
  assert.equal(readFileSync(join(dir, 'docs', 'metrics.md'), 'utf8'), metricsDoc());
});
