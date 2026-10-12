import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDemo as demoInProcess, HOLD_MS, PACE_MS } from '../scripts/demo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ISSUES = 'https://github.com/derrtaderr/revenue-sync/issues';

// The demo is what a stranger runs first, from a fresh clone with nothing set, so it runs here
// with an empty environment apart from PATH (and the pacing switched off, so the suite is fast).
export function runDemo(cwd = ROOT) {
  return spawnSync(process.execPath, [join(ROOT, 'scripts', 'demo.mjs')], { cwd, env: { PATH: process.env.PATH, REVENUE_SYNC_DEMO_PACE_MS: '0' }, encoding: 'utf8' });
}
const steps = (out) => out.split(/^(?=\$ )/m).filter((s) => s.startsWith('$ '));

test('the demo runs with no keys and exits 0', () => {
  const r = runDemo();
  assert.equal(r.status, 0, r.stderr + r.stdout);
});

test('the demo shows reconcile catching a hand edit in HubSpot, naming the company and both numbers, with exit 3', () => {
  const out = runDemo().stdout;
  assert.match(out, /Northwind Analytics \(HubSpot 100\)\n  MRR \(rs_mrr\): HubSpot says 1500, billing says 1300/);
  assert.match(out, /Reconcile failed\.[^\n]*\nexit 3/);
});

test('each step shows the command a cloned user can type, not a bare revenue-sync they do not have', () => {
  const out = runDemo().stdout;
  assert.doesNotMatch(out, /^\$ revenue-sync /m);
  assert.deepEqual(steps(out).map((s) => s.split('\n')[0]), [
    '$ node bin/revenue-sync.mjs seed --hubspot',
    '$ node bin/revenue-sync.mjs sync --usage usage.csv',
    '$ node bin/revenue-sync.mjs reconcile --usage usage.csv',
    '$ node bin/revenue-sync.mjs plan --usage usage.csv',
    '$ node bin/revenue-sync.mjs sync --usage usage.csv',
    '$ node bin/revenue-sync.mjs reconcile --usage usage.csv',
  ]);
});

test('after the catch it runs plan first, as reconcile advises, showing the write that fixes it', () => {
  const s = steps(runDemo().stdout);
  assert.match(s[3], /rs_mrr: 1500 → 1300 \(edited in HubSpot since the last sync\)/);
  assert.match(s[4], /Wrote 2 values to HubSpot\./);
  assert.match(s[5], /Checked values agree/);
});

test('every step states its exit code exactly once', () => {
  for (const s of steps(runDemo().stdout)) assert.equal(s.match(/^exit \d$|\bExit \d;/gm)?.length, 1, s);
});

test('the demo says up front it runs against stand-ins, with no keys, and shows only the key lines of each step', () => {
  const head = runDemo().stdout.split('\n').slice(0, 2).join('\n');
  assert.match(head, /stand-ins for Stripe and HubSpot/);
  assert.match(head, /no keys/i);
  assert.match(head, /key lines of each step/i);
});

test('the demo writes nothing to the folder it is run from', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rs-demo-cwd-'));
  const r = runDemo(cwd);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(cwd), []);
  assert.ok(!existsSync(join(cwd, '.revenue-sync')));
});

function sink() { const s = { text: '', write: (t) => { s.text += t; } }; return s; }

test('beats arrive one at a time, and the longest pause holds on the catch', async () => {
  const out = sink();
  const pauses = [];
  const code = await demoInProcess({ write: out.write, writeErr: () => {}, sleep: async (ms) => { pauses.push({ ms, before: out.text }); } });
  assert.equal(code, 0);
  assert.ok(pauses.length >= 6, `${pauses.length} pauses`);
  assert.ok(pauses.every((p) => p.ms === PACE_MS || p.ms === HOLD_MS));
  const holds = pauses.filter((p) => p.ms === HOLD_MS);
  assert.equal(holds.length, 1);
  assert.ok(HOLD_MS > PACE_MS);
  assert.match(holds[0].before, /billing says 1300[\s\S]*\nexit 3\n$/);
});

test('on an old Node it stops before running anything and says what to do next', async () => {
  const out = sink();
  const err = sink();
  const code = await demoInProcess({ write: out.write, writeErr: err.write, sleep: async () => {}, version: 'v18.19.0' });
  assert.equal(code, 1);
  assert.equal(out.text, '');
  assert.match(err.text, /Node 20\.6 or newer/);
  assert.match(err.text, /v18\.19\.0/);
  assert.ok(err.text.includes(ISSUES));
});

test('when a step does not do what the demo expects, it says which, and where to report it', async () => {
  const err = sink();
  const cli = async () => 2;
  const code = await demoInProcess({ write: () => {}, writeErr: err.write, sleep: async () => {}, cli });
  assert.equal(code, 1);
  assert.match(err.text, /expected exit 0 from seed, got 2/);
  assert.ok(err.text.includes(ISSUES));
});
