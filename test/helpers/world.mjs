// A whole fake world for CLI tests: fake Stripe and fake HubSpot behind one injected fetch,
// plus captured output streams.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakeStripe } from './fake-stripe.mjs';
import { createFakeHubSpot } from './fake-hubspot.mjs';
import { stripeTestKey, hubspotToken } from './keys.mjs';
import { createFakeBigQuery } from './fake-bigquery.mjs';
import { serviceAccountKey } from './google-key.mjs';

export function capture() {
  const sink = { text: '', write(s) { sink.text += s; return true; } };
  return sink;
}

// google: also a fake Google token endpoint and BigQuery, with GOOGLE_SERVICE_ACCOUNT_JSON set.
export function makeWorld({ stripeKey = stripeTestKey(), token = hubspotToken(), stripeOptions = {}, google = false } = {}) {
  const stripe = createFakeStripe({ key: stripeKey, ...stripeOptions });
  const hubspot = createFakeHubSpot({ token });
  const sa = serviceAccountKey();
  const bigquery = createFakeBigQuery({ key: sa.json, publicKey: sa.publicKey, now: () => Date.parse('2026-10-07T09:00:00Z') });
  const fetch = async (url, init) => {
    const host = new URL(url).host;
    if (host === 'api.stripe.com') return stripe.fetch(url, init);
    if (host === 'api.hubapi.com') return hubspot.fetch(url, init);
    if (google && (host === 'oauth2.googleapis.com' || host === 'bigquery.googleapis.com')) return bigquery.fetch(url, init);
    throw new TypeError(`unexpected host ${host}`);
  };
  const cwd = mkdtempSync(join(tmpdir(), 'rs-cli-'));
  const env = { STRIPE_API_KEY: stripeKey, HUBSPOT_TOKEN: token, ...(google ? { GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify(sa.json) } : {}) };
  async function run(main, argv, extra = {}) {
    const stdout = capture();
    const stderr = capture();
    const code = await main(argv, { env, fetch, sleep: async () => {}, random: () => 0, stdout, stderr, now: new Date('2026-10-07T09:00:00Z'), cwd, ...extra });
    return { code, out: stdout.text, err: stderr.text };
  }
  return { stripe, hubspot, bigquery, fetch, cwd, env, run };
}
