import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVerify } from 'node:crypto';
import { loadServiceAccount, signedAssertion, createTokenProvider, BIGQUERY_SCOPE, TOKEN_URL } from '../src/google-auth.mjs';
import { serviceAccountKey } from './helpers/google-key.mjs';
import { createFakeBigQuery } from './helpers/fake-bigquery.mjs';

const NOW = Date.UTC(2026, 9, 7, 9);
const decode = (part) => JSON.parse(Buffer.from(part, 'base64url'));

test('the key comes from GOOGLE_APPLICATION_CREDENTIALS (a path) or GOOGLE_SERVICE_ACCOUNT_JSON (the JSON itself)', () => {
  const { json } = serviceAccountKey();
  const text = JSON.stringify(json);
  const files = { '/keys/sa.json': text };
  assert.equal(loadServiceAccount({ GOOGLE_APPLICATION_CREDENTIALS: '/keys/sa.json' }, (p) => files[p]).client_email, json.client_email);
  assert.equal(loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: text }, () => { throw new Error('not read'); }).project_id, 'demo-project');
});

test('a missing, unreadable or malformed key is a plain message that never prints the key', () => {
  const { json } = serviceAccountKey();
  assert.throws(() => loadServiceAccount({}, () => ''), /GOOGLE_APPLICATION_CREDENTIALS .*GOOGLE_SERVICE_ACCOUNT_JSON/);
  assert.throws(() => loadServiceAccount({ GOOGLE_APPLICATION_CREDENTIALS: '/nope.json' }, () => { const e = new Error('x'); e.code = 'ENOENT'; throw e; }), /\/nope\.json does not exist/);
  const broken = JSON.stringify(json).slice(0, -5);
  assert.throws(() => loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: broken }), (err) => /not valid JSON/.test(err.message) && !err.message.includes('PRIVATE KEY'));
  assert.throws(() => loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...json, type: 'authorized_user' }) }), /service account key/);
  assert.throws(() => loadServiceAccount({ GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ ...json, private_key: undefined }) }), /private_key/);
});

test('I4: the token asks for the read-only Cloud Platform scope, which Google lists for jobs.query and getQueryResults', () => {
  assert.equal(BIGQUERY_SCOPE, 'https://www.googleapis.com/auth/cloud-platform.read-only');
});

test('the assertion is an RS256 JWT with the documented header and claims, signed with the key', () => {
  const { json, publicKey } = serviceAccountKey();
  const jwt = signedAssertion(json, { scope: BIGQUERY_SCOPE, now: NOW });
  const [h, c, sig] = jwt.split('.');
  assert.deepEqual(decode(h), { alg: 'RS256', typ: 'JWT', kid: json.private_key_id });
  assert.deepEqual(decode(c), { iss: json.client_email, scope: BIGQUERY_SCOPE, aud: TOKEN_URL, iat: NOW / 1000, exp: NOW / 1000 + 3600 });
  const v = createVerify('RSA-SHA256');
  v.update(`${h}.${c}`);
  assert.ok(v.verify(publicKey, Buffer.from(sig, 'base64url')));
  assert.doesNotMatch(jwt, /[+/=]/, 'base64url, unpadded');
});

function provider(over = {}) {
  const { json, publicKey } = serviceAccountKey();
  const fake = createFakeBigQuery({ key: json, publicKey, now: () => NOW });
  return { fake, tokens: createTokenProvider({ key: json, fetch: fake.fetch, sleep: async () => {}, random: () => 0, now: () => NOW, ...over }) };
}

test('the token exchange posts the jwt-bearer grant and returns the access token, once per run', async () => {
  const { fake, tokens } = provider();
  const t = await tokens.token();
  assert.match(t, /^ya29\./);
  assert.equal(await tokens.token(), t, 'cached while it is valid');
  const posts = fake.requests.filter((r) => r.host === 'oauth2.googleapis.com');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(new URLSearchParams(posts[0].body).get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
});

test('a token endpoint error names Google\'s error code and nothing from the key or the assertion', async () => {
  for (const [status, error] of [[400, 'invalid_grant'], [401, 'invalid_client'], [400, 'invalid_scope']]) {
    const { fake, tokens } = provider();
    fake.failures['POST /token'] = [() => new Response(JSON.stringify({ error, error_description: 'Invalid JWT Signature.' }), { status })];
    await assert.rejects(tokens.token(), (err) => {
      assert.equal(err.name, 'ApiError');
      assert.match(err.message, new RegExp(`Google refused the service account key \\(${error}\\)`));
      assert.doesNotMatch(err.message, /PRIVATE KEY|eyJ/);
      return true;
    });
  }
});

test('a 200 from the token endpoint without an access_token is an error, not an empty credential', async () => {
  const { fake, tokens } = provider();
  fake.failures['POST /token'] = [() => new Response(JSON.stringify({ token_type: 'Bearer', expires_in: 3599 }), { status: 200 })];
  await assert.rejects(tokens.token(), /no access token/);
});

test('a token past its expiry is fetched again', async () => {
  let now = NOW;
  const { json, publicKey } = serviceAccountKey();
  const fake = createFakeBigQuery({ key: json, publicKey, now: () => now });
  const tokens = createTokenProvider({ key: json, fetch: fake.fetch, sleep: async () => {}, random: () => 0, now: () => now });
  const a = await tokens.token();
  now += 3600 * 1000;
  assert.notEqual(await tokens.token(), a);
});
