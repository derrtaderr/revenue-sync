import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LINT = fileURLToPath(new URL('../scripts/lint.mjs', import.meta.url));
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const lint = (root) => spawnSync(process.execPath, [LINT, root], { encoding: 'utf8' });

function repo({ readme = 'fine\n', pkg = {}, code = 'export const x = 1;\n', extra = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-lint-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'README.md'), readme);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', ...pkg }));
  writeFileSync(join(dir, 'src', 'a.mjs'), code);
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return dir;
}

test('lint passes on this repository', () => {
  const r = lint(ROOT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('lint fails on an em dash in the README', () => {
  const r = lint(repo({ readme: 'a — b\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /em dash/);
});

test('lint fails on a runtime dependency', () => {
  const r = lint(repo({ pkg: { dependencies: { leftpad: '1.0.0' } } }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runtime dependencies/);
});

test('lint fails on a syntax error', () => {
  const r = lint(repo({ code: 'export const = ;\n' }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /syntax error/);
});

test('lint fails on a home-directory path in a shipped file', () => {
  const r = lint(repo({ code: `// see ${'/Us' + 'ers/someone'}/x\nexport const x = 1;\n` }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /maker-internal path/);
});

test('lint fails on a literal live Stripe secret key anywhere', () => {
  const r = lint(repo({ code: `export const k = '${'sk_' + 'live_'}abcdefghijklmnop';\n` }));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /secret-shaped/);
});
