import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/cli.mjs';
import { makeWorld } from './helpers/world.mjs';

function allFiles(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

const echo = (status, w) => () => new Response(JSON.stringify({ error: { message: `bad ${w.env.STRIPE_API_KEY} ${w.env.HUBSPOT_TOKEN}` }, message: `${w.env.HUBSPOT_TOKEN}` }), { status });

const scenarios = {
  'happy path': () => {},
  'stripe 401 echoing the key': (w) => { w.stripe.failures['GET /v1/customers'] = [echo(401, w)]; },
  'stripe 400 echoing the key': (w) => { w.stripe.failures['GET /v1/subscriptions'] = [echo(400, w)]; },
  'hubspot 403 echoing the token': (w) => { w.hubspot.failures['GET /crm/v3/objects/companies'] = [echo(403, w)]; },
  'hubspot 500 forever': (w) => { w.hubspot.failures['GET /crm/v3/objects/companies'] = Array.from({ length: 6 }, () => echo(500, w)); },
  'network down with the key in the error': (w) => { w.stripe.failures['GET /v1/customers'] = Array.from({ length: 6 }, () => () => { throw new TypeError(`connect failed ${w.env.STRIPE_API_KEY}`); }); },
  'unexpected exception carrying both secrets': (w) => { w.hubspot.failures['GET /crm/v3/objects/companies'] = [() => ({ get status() { throw new Error(`boom Bearer ${w.env.HUBSPOT_TOKEN} ${w.env.STRIPE_API_KEY}`); } })]; },
};

for (const [name, arrange] of Object.entries(scenarios)) {
  for (const command of ['plan', 'sync', 'reconcile']) {
    test(`no key or token in any output or state file: ${command}, ${name}`, async () => {
      const w = makeWorld();
      await w.run(main, ['seed', '--hubspot']);
      arrange(w);
      const r = await w.run(main, [command, '--usage', 'usage.csv']);
      assert.equal(typeof r.code, 'number');
      const texts = [r.out, r.err, ...allFiles(w.cwd).map((f) => readFileSync(f, 'utf8'))];
      for (const t of texts) {
        assert.ok(!t.includes(w.env.STRIPE_API_KEY), `Stripe key leaked (${name})`);
        assert.ok(!t.includes(w.env.HUBSPOT_TOKEN), `HubSpot token leaked (${name})`);
        assert.ok(!t.includes('8c1f2d3e-4a5b'), `token fragment leaked (${name})`);
      }
    });
  }
}

test('an unexpected exception exits 1 with the secrets redacted', async () => {
  const w = makeWorld();
  scenarios['unexpected exception carrying both secrets'](w);
  const r = await w.run(main, ['plan']);
  assert.equal(r.code, 1);
  assert.match(r.err, /Unexpected error: boom Bearer \[redacted\] \[redacted\]/);
});
