import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { DEFINITIONS } from '../src/definitions.mjs';
import { SCOPES } from '../src/hubspot.mjs';
import { reconcileExample } from './helpers/examples.mjs';
import { usage } from '../src/cli.mjs';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const section = (from, to) => README.slice(README.indexOf(from), to ? README.indexOf(to) : undefined);

test('the reconcile example is the real output of the tool', async () => {
  const m = /<!-- reconcile-output:start -->\n```text\n([\s\S]*?)```\n<!-- reconcile-output:end -->/.exec(README);
  assert.ok(m, 'README needs a ```text block between the reconcile-output markers');
  const ex = await reconcileExample();
  assert.equal(ex.code, 3);
  assert.equal(m[1], ex.out, 'README reconcile example is stale: paste the output of test/helpers/examples.mjs reconcileExample()');
});

test('the quickstart runs seed, plan, sync, reconcile in that order with commands that exist', () => {
  const q = section('## Five minute quickstart', '## Using it on your own data');
  const order = ['seed --hubspot', 'plan --usage usage.csv', 'sync --usage usage.csv', 'reconcile --usage usage.csv'].map((c) => q.indexOf(`node --env-file=.env bin/revenue-sync.mjs ${c}`));
  assert.ok(order.every((i) => i > 0), 'every quickstart command is shown');
  assert.deepEqual([...order].sort((a, b) => a - b), order);
});

test('every command and option in help is documented in the README', () => {
  for (const word of ['seed', 'plan', 'sync', 'reconcile', '--usage', '--mapping', '--dir', '--as-of', '--strict', '--hubspot', '--usage-out']) {
    assert.match(README, new RegExp(`(^|[\\s\`\\[(])${word}(?![\\w-])`, 'm'), word);
  }
  assert.ok(usage().length > 0);
});

test('the README names every HubSpot scope the tool needs', () => {
  for (const s of SCOPES) assert.ok(README.includes(s), s);
});

test('the README explains every metric (the generated table)', () => {
  for (const d of DEFINITIONS) assert.ok(README.includes(`\`${d.property}\``), d.property);
});

test('the README states what it refuses and why, the exit codes, and its limitations', () => {
  for (const h of ['## What it refuses, and why', '## Exit codes', '## Limitations', '## The account model']) assert.ok(README.includes(h), h);
  const exits = section('## Exit codes', '## Limitations');
  for (const c of ['| 0 |', '| 1 |', '| 2 |', '| 3 |', '| 4 |']) assert.ok(exits.includes(c), c);
});

test('the README says plainly what was verified live and what was not (live check)', () => {
  const status = README.slice(0, README.indexOf('## What a failed reconcile looks like'));
  assert.match(status, /2026-10-07/);
  assert.match(status, /Stripe test-mode account/);
  assert.match(status, /HubSpot test portal/);
  assert.match(status, /not yet been run on live-mode Stripe data/);
  assert.match(status, /restricted key/);
});

test('the Stripe key advice says automatic unlinking needs GET /v1/account, which is verified for a full test key and unverified for a restricted key (F1)', () => {
  const key = README.slice(README.indexOf('- **Stripe key.**'), README.indexOf('- **Usage CSV**'));
  assert.match(key, /GET \/v1\/account/);
  assert.match(key, /full secret key/);
  assert.match(key, /unverified/);
  assert.match(key, /--allow-unlink/);
});

test('every key placeholder in the README is refused by the tool, so it cannot be run literally', async () => {
  const { validStripeKey } = await import('../src/stripe.mjs');
  const { validToken } = await import('../src/hubspot.mjs');
  const stripe = [...README.matchAll(/^\s*STRIPE_API_KEY=(.*)$/gm)].map((m) => m[1]);
  const hub = [...README.matchAll(/^\s*HUBSPOT_TOKEN=(.*)$/gm)].map((m) => m[1]);
  assert.ok(stripe.length && hub.length);
  for (const v of stripe) assert.ok(!validStripeKey(v), v);
  for (const v of hub) assert.ok(!validToken(v), v);
});

test('the README documents the unlink guard, --allow-unlink and exit 5 (B4.5)', () => {
  const exits = section('## Exit codes', '## Limitations');
  assert.match(exits, /\| 5 \| [^\n]*unlink/);
  assert.match(README, /--allow-unlink/);
  assert.match(README, /more than 2 companies and more than 10 percent/);
  assert.match(usage(), /--allow-unlink/);
  assert.match(usage(), /5 sync refused to unlink/);
});

test('the README sends a team that stops using a mapping file to plan with an empty file first (pre-public review I2)', () => {
  const m = README.slice(README.indexOf('- **Mapping CSV**'), README.indexOf('- **State folder**'));
  assert.match(m, /first run `plan --mapping` with an empty file/);
  assert.match(m, /to see what that clears/);
});

test('the README says what an unreadable Stripe account really does: churn is held with its old values and reconcile still exits 0 (pre-public review I4)', () => {
  const key = README.slice(README.indexOf('- **Stripe key.**'), README.indexOf('- **Usage CSV**'));
  assert.doesNotMatch(key, /nothing breaks/);
  assert.match(key, /keeps its last MRR/);
  assert.match(key, /plain `reconcile` still exits 0/);
  assert.match(key, /`plan`, `sync` and `reconcile` say so on every run/);
});

test('the README, like the SPEC, says a restricted key is unverified for every endpoint, not only GET /v1/account (pre-public review m-c)', () => {
  const key = README.slice(README.indexOf('- **Stripe key.**'), README.indexOf('- **Usage CSV**'));
  assert.match(key, /A restricted key has not been run against Stripe at all, so it is unverified for every endpoint/);
  assert.doesNotMatch(key, /covers the lists `plan`, `sync` and `reconcile` read/);
  // .vibecodepm/ is a build-process folder removed before the repo goes public.
  const flowUrl = new URL('../.vibecodepm/flow.md', import.meta.url);
  if (existsSync(flowUrl)) assert.doesNotMatch(readFileSync(flowUrl, 'utf8'), /A restricted read-only key reads the lists/);
});

test('the README exit-2 row names the journal under the state folder, not a fixed path (m1)', () => {
  const exits = section('## Exit codes', '## Limitations');
  assert.match(exits, /\| 2 \|[^\n]*delete `<dir>\/journal\.jsonl`/);
  assert.doesNotMatch(exits, /`\.revenue-sync\/journal\.jsonl`/);
});

test('the README has a "Using a warehouse" section: sandbox quickstart (no card), the two IAM roles, the flags, and honest limitations', () => {
  const wh = section('## Using a warehouse', '## Commands');
  assert.ok(README.includes('## Using a warehouse'));
  for (const s of ['BigQuery sandbox', 'no credit card', 'BigQuery Job User', 'BigQuery Data Viewer', '--billing-sql', '--usage-sql', '--bigquery-project', '--bigquery-location', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'docs/warehouse.md', 'STRIPE_API_KEY', 'exit 3', 'examples/bigquery/demo-billing.sql']) assert.ok(wh.includes(s), s);
  assert.doesNotMatch(wh, /not yet been run against Google/);
  assert.doesNotMatch(wh, /has not yet been run on BigQuery/);
  assert.match(wh, /Snowflake/);
  for (const flag of ['--billing-sql', '--usage-sql', '--bigquery-project', '--bigquery-location']) assert.match(usage(), new RegExp(flag));
});

test('I4: the README says the SQL may only read, the token is read-only, and the Data Editor key made for Stripe Data Pipeline must not be reused', () => {
  const wh = section('## Using a warehouse', '## Commands');
  assert.match(wh, /dry run/);
  assert.match(wh, /anything that is not a `SELECT`/);
  assert.match(wh, /cloud-platform\.read-only/);
  assert.match(wh, /BigQuery Data Editor/);
  assert.match(wh, /do not reuse/i);
});

test('I5 and m7: the warehouse limitations say what no check catches: dollars where cents were meant, and a partial or stale load writing MRR 0', () => {
  const lim = section('### Warehouse limitations', '## Commands');
  assert.match(lim, /`unit_amount` in dollars instead of cents/);
  assert.match(lim, /only the cross-source check can catch it/);
  assert.match(lim, /`sync` does not run the cross-source check/);
  assert.match(lim, /partial or stale load/);
  assert.match(lim, /MRR 0/);
  assert.match(lim, /still linked by usage/);
});

test('live BigQuery run: the warehouse section records what was verified on 2026-10-08 and what still is not', () => {
  const wh = section('## Using a warehouse', '## Commands');
  const lim = section('### Warehouse limitations', '## Commands');
  assert.match(lim, /2026-10-08/);
  for (const fact of ['dry run', 'statementType', 'cloud-platform.read-only', 'cross-source check']) assert.ok(lim.includes(fact), fact);
  assert.match(lim, /Stripe Data Pipeline example has not been run/);
  assert.match(lim, /canceled subscription/);
  // The demo quickstart now states the live result, and keeps the 14-day caveat.
  const demo = section('### BigQuery sandbox quickstart', '### Warehouse limitations');
  assert.match(demo, /2026-10-08/);
  assert.match(demo, /14 days/);
  assert.doesNotMatch(demo, /are expected to show/);
  assert.doesNotMatch(demo, /agreeing on every company|agreed everywhere/);
  assert.doesNotMatch(wh, /fallback/i);
});

test('m-B: the warehouse limitations say a discount row dropped by the user\'s own SQL is invisible to row checks and only the cross-source check can catch it', () => {
  const lim = section('### Warehouse limitations', '## Commands');
  const bullet = lim.split('\n- ').find((b) => /inner join/i.test(b)) ?? '';
  assert.match(bullet, /discount/);
  assert.match(bullet, /no row check can see/);
  assert.match(bullet, /only the cross-source check can catch it/);
});

test('the README keeps the two roles as a recommendation and does not claim the live run verified them', () => {
  const lim = section('### Warehouse limitations', '## Commands');
  assert.doesNotMatch(lim, /holding only the two read roles/);
  assert.match(lim, /dedicated service account created for the run, using the `cloud-platform\.read-only` token scope/);
  assert.match(section('## Using a warehouse', '### BigQuery sandbox quickstart'), /needs two roles: \*\*BigQuery Job User\*\*/);
});

test('the warehouse limitations name both terminal statuses that may arrive without items', () => {
  const lim = section('### Warehouse limitations', '## Commands');
  assert.match(lim, /a `canceled` or `incomplete_expired` subscription with no item rows is read/);
});

test('the warehouse limitations say a Drive or Sheets backed table is not supported', () => {
  const lim = section('### Warehouse limitations', '## Commands');
  const bullet = lim.split('\n- ').find((b) => /Google Drive or Sheets/.test(b)) ?? '';
  assert.match(bullet, /Drive scope/);
  assert.match(bullet, /not supported/);
});
