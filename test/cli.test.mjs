import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main, usage } from '../src/cli.mjs';
import { makeWorld } from './helpers/world.mjs';
import { stripeLiveKey } from './helpers/keys.mjs';

test('help lists every command and both environment variables', async () => {
  const w = makeWorld();
  const r = await w.run(main, ['help']);
  assert.equal(r.code, 0);
  for (const word of ['seed', 'plan', 'sync', 'reconcile', 'STRIPE_API_KEY', 'HUBSPOT_TOKEN', '--usage', '--mapping', '--strict', '--hubspot']) assert.ok(r.out.includes(word), word);
  assert.equal(r.out, usage());
});

test('an unknown command or option is a usage error, exit 1', async () => {
  const w = makeWorld();
  assert.equal((await w.run(main, ['launch'])).code, 1);
  const r = await w.run(main, ['plan', '--colour']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Unknown option "--colour"/);
});

test('missing or malformed keys stop before any request, exit 1', async () => {
  for (const [env, msg] of [
    [{ HUBSPOT_TOKEN: 'x' }, /STRIPE_API_KEY is not set/],
    [{ STRIPE_API_KEY: 'pk_test_123', HUBSPOT_TOKEN: 'x' }, /STRIPE_API_KEY does not look like/],
    [{ STRIPE_API_KEY: makeWorld().env.STRIPE_API_KEY }, /HUBSPOT_TOKEN is not set/],
  ]) {
    const w = makeWorld();
    const r = await w.run(main, ['plan'], { env });
    assert.equal(r.code, 1);
    assert.match(r.err, msg);
    assert.equal(w.stripe.requests.length + w.hubspot.requests.length, 0);
  }
});

test('seed refuses a live key, exit 1, nothing sent', async () => {
  const w = makeWorld({ stripeKey: stripeLiveKey() });
  const r = await w.run(main, ['seed']);
  assert.equal(r.code, 1);
  assert.match(r.err, /only runs on a Stripe test key/);
  assert.equal(w.stripe.requests.length, 0);
});

test('a usage file with the wrong columns stops before any request', async () => {
  const w = makeWorld();
  writeFileSync(join(w.cwd, 'u.csv'), 'a,b\n1,2\n');
  const r = await w.run(main, ['plan', '--usage', 'u.csv']);
  assert.equal(r.code, 1);
  assert.match(r.err, /usage CSV needs the columns/);
  assert.equal(w.stripe.requests.length, 0);
});

test('a usage file that does not exist stops before any request', async () => {
  const w = makeWorld();
  const r = await w.run(main, ['plan', '--usage', 'missing.csv']);
  assert.equal(r.code, 1);
  assert.match(r.err, /The usage file .* does not exist/);
});

test('an API error is exit 2 and says nothing was written', async () => {
  const w = makeWorld();
  w.stripe.failures['GET /v1/customers'] = [() => new Response('{}', { status: 401 })];
  const r = await w.run(main, ['sync']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Stripe rejected the key \(401\)/);
  assert.match(r.err, /Nothing was written to HubSpot/);
});

test('plan never writes to HubSpot, and saves the account model', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const before = w.hubspot.requests.filter((x) => x.method === 'POST' && !x.path.endsWith('/batch/read')).length;
  const r = await w.run(main, ['plan', '--usage', 'usage.csv']);
  assert.equal(r.code, 0, r.err);
  assert.equal(w.hubspot.requests.filter((x) => x.method === 'POST' && !x.path.endsWith('/batch/read')).length, before);
  assert.match(r.out, /Would create the property group revenue_sync and 10 properties/);
  assert.ok(existsSync(join(w.cwd, '.revenue-sync', 'model.json')));
  const model = JSON.parse(readFileSync(join(w.cwd, '.revenue-sync', 'model.json'), 'utf8'));
  assert.equal(model.schema, 'revenue-sync.account-model');
});

test('every run appends one redacted line to run.log', async () => {
  const w = makeWorld();
  await w.run(main, ['plan']);
  const log = readFileSync(join(w.cwd, '.revenue-sync', 'run.log'), 'utf8');
  assert.match(log, /^2026-10-07T09:00:00.000Z plan exit=0/m);
});

test('run.log records whether a run was on seeded or real Stripe data, so activation can be read from it', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  await w.run(main, ['sync', '--usage', 'usage.csv']);
  const r = await w.run(main, ['reconcile', '--usage', 'usage.csv']);
  assert.equal(r.code, 0);
  const log = readFileSync(join(w.cwd, '.revenue-sync', 'run.log'), 'utf8');
  assert.match(log, /^2026-10-07T09:00:00.000Z reconcile exit=0 data=seed$/m);
  w.stripe.db.customers.push({ id: 'cus_real', object: 'customer', email: 'a@real.example', metadata: {} });
  await w.run(main, ['reconcile', '--usage', 'usage.csv']);
  assert.match(readFileSync(join(w.cwd, '.revenue-sync', 'run.log'), 'utf8'), /reconcile exit=0 data=mixed$/m);
});

test('two syncs cannot run at once: a held lock stops the second before any request (m7)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(w.cwd, '.revenue-sync'), { recursive: true });
  writeFileSync(join(w.cwd, '.revenue-sync', 'sync.lock'), '{"pid":4242,"since":"2026-10-07T08:59:00.000Z"}\n');
  const before = w.hubspot.requests.length;
  const r = await w.run(main, ['sync', '--usage', 'usage.csv']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Another sync is running \(pid 4242, since 2026-10-07T08:59:00.000Z\)/);
  assert.match(r.err, /sync\.lock/);
  assert.equal(w.hubspot.requests.length, before);
});

test('a finished or failed sync releases its lock', async () => {
  const w = makeWorld();
  await w.run(main, ['seed', '--hubspot']);
  assert.equal((await w.run(main, ['sync', '--usage', 'usage.csv'])).code, 0);
  assert.equal(existsSync(join(w.cwd, '.revenue-sync', 'sync.lock')), false);
  w.hubspot.failures['GET /crm/v3/objects/companies'] = [() => new Response('{}', { status: 401 })];
  assert.equal((await w.run(main, ['sync', '--usage', 'usage.csv'])).code, 2);
  assert.equal(existsSync(join(w.cwd, '.revenue-sync', 'sync.lock')), false);
});

test('seed with a malformed key gets the malformed-key message, not the live-key one (m1)', async () => {
  const w = makeWorld();
  const r = await w.run(main, ['seed'], { env: { STRIPE_API_KEY: 'sk_test_ab"cd' } });
  assert.equal(r.code, 1);
  assert.match(r.err, /does not look like a Stripe secret or restricted key/);
  assert.doesNotMatch(r.err, /only runs on a Stripe test key/);
});

test('every missing key is reported at once (m4)', async () => {
  const w = makeWorld();
  const r = await w.run(main, ['plan'], { env: {} });
  assert.equal(r.code, 1);
  assert.match(r.err, /STRIPE_API_KEY is not set/);
  assert.match(r.err, /HUBSPOT_TOKEN is not set/);
});

test('a missing input file is named plainly (m4)', async () => {
  const w = makeWorld();
  const r = await w.run(main, ['plan', '--usage', 'nope.csv']);
  assert.match(r.err, /The usage file .*nope\.csv does not exist\./);
});

test('help says how to load keys from a .env file (m2)', () => {
  assert.match(usage(), /node --env-file=\.env bin\/revenue-sync\.mjs/);
});

test('help does not promise that a restricted key is enough for everything: unlinking needs the account read (F1)', () => {
  assert.match(usage(), /GET \/v1\/account/);
  assert.doesNotMatch(usage(), /A read-only restricted key is enough\s+for plan, sync and reconcile\./);
});

test('a corrupted synced.json stops plan, sync and reconcile with a clear message before any request (pre-public review m-f)', async () => {
  for (const bad of ['not json', '[]', '"x"', '{"links":{"1":5}}', '{"links":[]}', '{"values":"x"}', '{"values":{"1":7}}', '{"stripe_account":7}', '{"names":{"1":7}}', '{"links":{"1":["mapping",3]}}']) {
    const w = makeWorld();
    await w.run(main, ['seed', '--hubspot']);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(w.cwd, '.revenue-sync'), { recursive: true });
    writeFileSync(join(w.cwd, '.revenue-sync', 'synced.json'), bad);
    for (const cmd of ['plan', 'sync', 'reconcile']) {
      const before = w.stripe.requests.length + w.hubspot.requests.length;
      const r = await w.run(main, [cmd]);
      assert.equal(r.code, 1, `${cmd} ${bad}: ${r.out}${r.err}`);
      assert.doesNotMatch(r.err, /Unexpected error|is not a function/, `${cmd} ${bad}`);
      assert.match(r.err, /synced\.json/, `${cmd} ${bad}`);
      assert.match(r.err, /[Mm]ove it aside/, `${cmd} ${bad}`);
      assert.equal(w.stripe.requests.length + w.hubspot.requests.length, before, `${cmd} ${bad}: nothing fetched`);
    }
  }
});

test('help and the missing-key message recommend the sk_test_ secret key, and help gives the mapping escape (pre-public review m-d)', async () => {
  const help = usage();
  assert.match(help, /Start with the full secret key from a\s+Stripe sandbox \(sk_test_\)/);
  assert.match(help, /--mapping FILE[\s\S]*Once a sync has used one, sync refuses to run without it[\s\S]*plan --mapping with an\s+empty file \(header only\) first/);
  const w = makeWorld();
  const r = await w.run(main, ['plan'], { env: { HUBSPOT_TOKEN: w.env.HUBSPOT_TOKEN } });
  assert.equal(r.code, 1);
  assert.match(r.err, /STRIPE_API_KEY is not set\. Put a Stripe secret key in \.env \(start with the full secret key from a Stripe sandbox, sk_test_\)/);
});

test("seed's Next line is a command that runs as printed, with --env-file=.env (pre-public review m-i)", async () => {
  const w = makeWorld();
  const r = await w.run(main, ['seed']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /\nNext: node --env-file=\.env bin\/revenue-sync\.mjs plan --usage usage\.csv\n$/);
});

test('plan against a portal with no companies prints one coherent message, not "Nothing to write" beside "Run sync" (pre-public review m-i)', async () => {
  const w = makeWorld();
  await w.run(main, ['seed']);
  const r = await w.run(main, ['plan']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /HubSpot has no companies, so nothing can be matched or written \(sync would only create the revenue_sync properties\)\. Create the companies in HubSpot, or run seed --hubspot on a test portal, then run plan again\.\n$/);
  assert.doesNotMatch(r.out, /Nothing to write/);
  assert.doesNotMatch(r.out, /Run sync to write this/);
});

test('the --dir help names the one-folder scope and absolute paths for cron (m4)', () => {
  assert.match(usage(), /--dir DIR[\s\S]*Use the same folder every run[\s\S]*absolute path from cron/);
});
