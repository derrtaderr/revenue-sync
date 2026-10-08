import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SPEC = readFileSync(join(ROOT, 'docs', 'SPEC.md'), 'utf8');
const gates = SPEC.slice(SPEC.indexOf('## Per-area gates'));

test('every test file named in the spec gates exists', () => {
  for (const [, f] of gates.matchAll(/(test\/[\w-]+\.test\.mjs)/g)) assert.ok(existsSync(join(ROOT, f)), `${f} is named in docs/SPEC.md but does not exist`);
});

test('every test file belongs to a gate in the spec', () => {
  for (const f of readdirSync(join(ROOT, 'test')).filter((x) => x.endsWith('.test.mjs'))) {
    assert.ok(gates.includes(`test/${f}`), `test/${f} is in no per-area gate in docs/SPEC.md`);
  }
});

test('the spec records where this build diverges from the brief', () => {
  assert.match(SPEC, /## Divergences from the brief/);
});

test('the spec records the pre-public checklist as completed and names no build-process file (I7)', () => {
  const list = SPEC.slice(SPEC.indexOf('## Pre-public checklist'), SPEC.indexOf('## Per-area gates'));
  assert.ok(SPEC.includes('## Pre-public checklist'));
  assert.match(list, /completed/i);
  assert.doesNotMatch(SPEC, /WIRING\.md|\.vibecodepm/);
});

test('the spec answers the questions the author did not ask', () => {
  const q = SPEC.slice(SPEC.indexOf("## Questions the author didn't ask"));
  assert.ok(SPEC.includes("## Questions the author didn't ask"));
  for (const word of ['Stripe Billing', 'pause_collection', 'credit note', 'customer balance', 'currency']) assert.match(q, new RegExp(word, 'i'), word);
});

test('the spec states the unlink guard and its thresholds (B4.5)', () => {
  assert.match(SPEC, /### The unlink guard/);
  assert.match(SPEC, /10 percent/);
  assert.doesNotMatch(SPEC, /Detection reads HubSpot itself,\s+not `synced\.json`, so it works from any state folder/);
});

test('the spec records what was verified live, with the date, and what was not (live check)', () => {
  const live = SPEC.slice(SPEC.indexOf('## Verified live (2026-10-07)'));
  assert.ok(SPEC.includes('## Verified live (2026-10-07)'));
  for (const fact of ['applies_to', '207', 'GET /v1/account', '2166.67', 'Not verified live']) assert.ok(live.includes(fact), fact);
  assert.match(live, /restricted/);
});

test('the live re-run on the pre-release build is recorded, and no build file still calls it pending (pre-public review m-b)', () => {
  const live = SPEC.slice(SPEC.indexOf('## Verified live (2026-10-07)'), SPEC.indexOf('## Divergences from the brief'));
  for (const fact of ['pre-release build', 'Northwind 1300', 'Soylent 420', '77 values']) assert.ok(live.includes(fact), fact);
  // Both are build-process files removed before the repo goes public, so they are checked only
  // while they exist.
  if (existsSync(join(ROOT, '.vibecodepm', 'metrics.md'))) {
    const metrics = readFileSync(join(ROOT, '.vibecodepm', 'metrics.md'), 'utf8');
    assert.doesNotMatch(metrics, /to be re-run/);
  }
  if (existsSync(join(ROOT, 'WIRING.md'))) {
    const wiring = readFileSync(join(ROOT, 'WIRING.md'), 'utf8');
    assert.doesNotMatch(wiring, /then a re-run of the live quickstart/);
  }
});

test('divergence 11 gives the plan-first escape, and the Stripe-account warning is said to print on every run (m2, m3)', () => {
  const div = SPEC.slice(SPEC.indexOf('## Divergences from the brief'));
  const d11 = div.slice(div.indexOf('11. '), div.indexOf('12. '));
  assert.match(d11, /run `plan --mapping` with an empty file first/);
  assert.doesNotMatch(SPEC, /say it on the first run/);
  assert.match(SPEC, /say it on every run/);
});

// The repository goes public from a squashed tree without its build-process files. Nothing that
// ships may point at the author's private workspace. The terms are assembled at runtime so this
// file does not match its own scan.
test('the public tree carries no private references: workspace names, review-queue rows, or commit ids that a squashed repo would not have', () => {
  const words = [['ja', 'son'], ['orches', 'trator'], ['va', 'ult'], ['build', ' lane'], ['life', '_os'], ['gtm', '-loops'], ['build', '-queue'], ['ship', 'check'], ['Magne', 'tiz'], ['RevWi', 'sely']].map((p) => p.join(''));
  const patterns = [...words.map((w) => new RegExp(`\\b${w}\\b`, 'i')), new RegExp(['\\bro', 'w 9\\d'].join(''), 'i'), /`[0-9a-f]{7}`/];
  const skip = new Set(['.git', 'node_modules', '.vibecodepm', '.revenue-sync', 'WIRING.md', 'LICENSE']);
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (skip.has(e.name) ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
  const hits = [];
  for (const file of walk(ROOT)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const re of patterns) if (re.test(line)) hits.push(`${file.slice(ROOT.length)}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('the spec records the live BigQuery run (2026-10-08) and what it could not verify', () => {
  const bq = SPEC.slice(SPEC.indexOf('### BigQuery (2026-10-08)'), SPEC.indexOf('## Divergences from the brief'));
  assert.ok(SPEC.includes('### BigQuery (2026-10-08)'));
  for (const fact of ['statementType', 'cloud-platform.read-only', '11 customers', '12 subscriptions', '70 values', 'cross=fail', 'warehouse 2000, Stripe 0', 'subscription_items', '[unverified]']) assert.ok(bq.includes(fact), fact);
  assert.doesNotMatch(SPEC, /Open until the live run/);
  assert.doesNotMatch(SPEC, /not yet seen live/);
  assert.doesNotMatch(SPEC, /documented fallback if a live run/);
  for (const n of [29, 30, 31, 32, 33]) assert.match(SPEC, new RegExp(`\\n${n}\\. \\*\\*`), `divergence ${n}`);
  if (existsSync(join(ROOT, '.vibecodepm', 'metrics.md'))) {
    assert.doesNotMatch(readFileSync(join(ROOT, '.vibecodepm', 'metrics.md'), 'utf8'), /has not been run against Google/);
  }
});

test('the live BigQuery record claims only what the run exercised (getQueryResults, encodings, which companies agreed)', () => {
  const bq = SPEC.slice(SPEC.indexOf('### BigQuery (2026-10-08)'), SPEC.indexOf('## Divergences from the brief'));
  assert.match(bq, /runs query jobs \(`jobs\.query`\); `getQueryResults` was not exercised live/);
  assert.doesNotMatch(bq, /\(`jobs\.query` and `getQueryResults`\)/);
  assert.doesNotMatch(bq, /strings for INT64, NUMERIC and BIGNUMERIC/, 'the demo outputs no BIGNUMERIC column');
  assert.match(bq, /BIGNUMERIC[^|]*were not seen live/);
  assert.doesNotMatch(SPEC, /agreed on every company but/);
  assert.doesNotMatch(SPEC, /which ran query jobs live/);
});

test('the live BigQuery run does not claim the service account\'s IAM roles were verified', () => {
  const bq = SPEC.slice(SPEC.indexOf('### BigQuery (2026-10-08)'), SPEC.indexOf('## Divergences from the brief'));
  assert.doesNotMatch(bq, /holding only the two read roles/);
  assert.match(bq, /dedicated service account created for the run, using the\s+`cloud-platform\.read-only` token scope/);
  assert.match(bq, /roles it was granted were\s+not checked/);
});

test('the user flow names both terminal statuses and has one access-denied row', { skip: !existsSync(join(ROOT, '.vibecodepm', 'flow.md')) }, () => {
  const flow = readFileSync(join(ROOT, '.vibecodepm', 'flow.md'), 'utf8');
  assert.doesNotMatch(flow, /non-canceled subscription/);
  assert.match(flow, /a subscription with no item that is not `canceled` or `incomplete_expired`/);
  assert.equal(flow.split('\n').filter((l) => /^\| (BigQuery 403, IAM permission denied|Access denied)/.test(l)).length, 1);
});
