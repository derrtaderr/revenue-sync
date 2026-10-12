// The first screen of the README: the promise, the exhibit, and the shortest working command, in
// that order. The command in the block is the one this file runs, and the exhibit's storyboard
// and manifest are checked against what the demo prints today.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOLD_MS } from '../scripts/demo.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const FOLD = 15; // lines a stranger sees before scrolling
const PUBLIC = 'https://github.com/derrtaderr/revenue-sync';

function aboveFold() {
  const lines = README.split('\n');
  const nonEmpty = lines.map((l, i) => [l, i]).filter(([l]) => l.trim());
  const [title, promise, image, fence] = nonEmpty;
  const close = lines.indexOf('```', fence?.[1] + 1);
  return { lines, title, promise, image, fence, close, block: lines.slice(fence?.[1] + 1, close) };
}

const storyboard = readFileSync(join(ROOT, 'docs', 'demo', 'storyboard.yaml'), 'utf8');
const yamlValue = (key) => {
  const m = new RegExp(`^\\s*-?\\s*${key}: (.*)$`, 'm').exec(storyboard);
  assert.ok(m, `storyboard has no ${key}`);
  return m[1].trim();
};
const runDemo = (command) => {
  const [bin, ...args] = command.split(' ');
  assert.equal(bin, 'node');
  return spawnSync(process.execPath, args, { cwd: ROOT, env: { PATH: process.env.PATH, REVENUE_SYNC_DEMO_PACE_MS: '0' }, encoding: 'utf8' });
};

test('the README opens with the title, then the one-line promise', () => {
  const { title, promise } = aboveFold();
  assert.equal(title[0], '# revenue-sync');
  for (const w of ['Stripe billing', 'product usage', 'warehouse', 'HubSpot', 'reconciled']) assert.ok(promise[0].includes(w), w);
  assert.doesNotMatch(promise[0], /[—:]/, 'no em dash or colon in the promise');
});

test('then the exhibit, a GIF in the repo under 5 MB', () => {
  const { image } = aboveFold();
  const m = /^!\[[^\]]+\]\(([^)]+\.gif)\)$/.exec(image[0]);
  assert.ok(m, `the second thing is an image: ${image[0]}`);
  const file = join(ROOT, m[1]);
  assert.ok(existsSync(file), m[1]);
  assert.ok(statSync(file).size < 5_000_000, `${m[1]} is ${statSync(file).size} bytes`);
  assert.equal(readFileSync(file).subarray(0, 6).toString('latin1'), 'GIF89a');
});

test('then one bash block, all of it above the fold, that clones the public repo and runs the demo', () => {
  const { fence, close, block } = aboveFold();
  assert.equal(fence[0], '```bash');
  assert.ok(close > 0 && close < FOLD, `the block closes on line ${close + 1}`);
  assert.deepEqual(block, [`git clone ${PUBLIC}`, 'cd revenue-sync', 'node scripts/demo.mjs']);
});

test('the command in the block runs from the repo with no environment and shows the catch', () => {
  const r = runDemo(aboveFold().block.at(-1));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /HubSpot says 1500, billing says 1300/);
});

test('the line under the block says the demo needs no keys and a real run does', () => {
  const { lines, close } = aboveFold();
  const next = lines.slice(close + 1).find((l) => l.trim());
  assert.match(next, /no keys/i);
  assert.match(next, /Stripe/);
  assert.match(next, /HubSpot/);
});

test('the clone appears once; the quickstart points back at it rather than repeating it', () => {
  assert.equal(README.split('git clone').length - 1, 1);
});

test('the storyboard runs the same command, pinned to a commit, and its expect holds against the demo today', () => {
  const command = yamlValue('command');
  assert.equal(command, aboveFold().block.at(-1));
  assert.match(yamlValue('ref'), /^[0-9a-f]{40}$/);
  assert.equal(yamlValue('repo'), `${PUBLIC}-dev`);
  const r = runDemo(command);
  assert.equal(r.status, Number(yamlValue('exitCode')));
  assert.match(r.stdout, new RegExp(JSON.parse(yamlValue('output'))));
});

const wrappedRows = (lines, cols) => lines.reduce((n, l) => n + Math.max(1, Math.ceil(l.length / cols)), 0);

test('the catch fits the storyboard terminal, so the exhibit holds on all of it', () => {
  const cols = Number(yamlValue('cols'));
  const rows = Number(yamlValue('rows'));
  const out = runDemo(yamlValue('command')).stdout;
  const a = out.lastIndexOf('$ ', out.indexOf('HubSpot says 1500'));
  const b = out.indexOf('\nexit 3\n') + '\nexit 3'.length;
  const used = wrappedRows(out.slice(a, b).split('\n'), cols);
  assert.ok(used <= rows, `${used} rows on a ${rows} row terminal`);
});

test('the storyboard keeps the hold on the catch (maxPauseMs is at least the hold) and the exhibit stays within 15 seconds', () => {
  assert.ok(Number(yamlValue('maxPauseMs')) >= HOLD_MS, `maxPauseMs ${yamlValue('maxPauseMs')} < hold ${HOLD_MS}`);
  const manifest = JSON.parse(readFileSync(join(ROOT, 'docs', 'demo', 'exhibit.json'), 'utf8'));
  assert.ok(manifest.qc.ok && manifest.qc.seconds <= 15, JSON.stringify(manifest.qc));
});

test('the exhibit manifest matches the GIF on disk and what the demo prints today (re-render when either changes)', () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'docs', 'demo', 'exhibit.json'), 'utf8'));
  const gif = readFileSync(join(ROOT, 'docs', 'demo', manifest.gif));
  assert.equal(createHash('sha256').update(gif).digest('hex'), manifest.gifSha256, 'the GIF changed without the manifest');
  assert.equal(manifest.renderedFrom, yamlValue('ref'));
  assert.equal(runDemo(yamlValue('command')).stdout, manifest.output, 'the demo prints something the GIF does not show; re-render it');
});

// .vibecodepm/ is a build-process folder removed before a public release, so this checks it only
// where it exists.
test('the user flow starts at the front door: entry point 0 and happy path step 0 are the no-key demo (fix wave 1, I1)', { skip: !existsSync(join(ROOT, '.vibecodepm', 'flow.md')) }, () => {
  const flow = readFileSync(join(ROOT, '.vibecodepm', 'flow.md'), 'utf8');
  const entries = flow.slice(flow.indexOf('## Entry points'), flow.indexOf('## Happy path'));
  const zero = entries.slice(entries.indexOf('0. '), entries.indexOf('1. '));
  assert.ok(entries.indexOf('0. ') >= 0 && entries.indexOf('0. ') < entries.indexOf('1. '), 'entry point 0 comes first');
  for (const s of ['node scripts/demo.mjs', 'exit 0', 'exit 3', 'Node 20.6', 'github.com/derrtaderr/revenue-sync/issues', 'quickstart']) assert.ok(zero.includes(s), s);
  const happy = flow.slice(flow.indexOf('## Happy path'), flow.indexOf('## Real-data path'));
  assert.match(happy, /\| 0 \| [^\n]*node scripts\/demo\.mjs/);
  assert.ok(happy.indexOf('| 0 |') < happy.indexOf('| 1 |'));
});
