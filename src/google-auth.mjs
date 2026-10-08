// Google OAuth2 for a service account, with no dependency: an RS256 JWT signed with node:crypto,
// exchanged at Google's token endpoint for an access token
// (developers.google.com/identity/protocols/oauth2/service-account). The private key and the
// access token never reach a message: errors are built from status codes and Google's error
// code only.

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequester, ApiError } from './http.mjs';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
// The read-only Cloud Platform scope: the BigQuery discovery document lists it for both jobs.query
// and getQueryResults. A live run (2026-10-08) ran jobs.query under it (getQueryResults was not
// exercised live). No fallback scope.
export const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/cloud-platform.read-only';
const LIFETIME_SECONDS = 3600; // Google's maximum: exp at most one hour after iat.

export class CredentialsError extends Error {}

const NEEDED = 'Set GOOGLE_APPLICATION_CREDENTIALS to the path of a service account key JSON file, or GOOGLE_SERVICE_ACCOUNT_JSON to its contents (see the README, "Using a warehouse").';

export function loadServiceAccount(env, readFile = (p) => readFileSync(p, 'utf8')) {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  const inline = env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  let text;
  let where;
  if (inline) { text = inline; where = 'GOOGLE_SERVICE_ACCOUNT_JSON'; }
  else if (path) {
    where = `The service account key file ${path}`;
    try { text = readFile(path); } catch (err) {
      throw new CredentialsError(err.code === 'ENOENT' ? `${where} does not exist. ${NEEDED}` : `${where} cannot be read (${err.code ?? 'error'}).`);
    }
  } else throw new CredentialsError(`No Google credentials. ${NEEDED}`);
  let key;
  try { key = JSON.parse(text); } catch { throw new CredentialsError(`${where} is not valid JSON. ${NEEDED}`); }
  if (key?.type !== 'service_account') throw new CredentialsError(`${where} is not a service account key (its type is ${JSON.stringify(key?.type ?? null)}). Create a JSON key for a service account in the Google Cloud console.`);
  for (const field of ['client_email', 'private_key']) {
    if (typeof key[field] !== 'string' || !key[field]) throw new CredentialsError(`${where} has no ${field}. Download the JSON key again from the Google Cloud console.`);
  }
  return key;
}

const b64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export function signedAssertion(key, { scope, now }) {
  const iat = Math.floor(now / 1000);
  const header = { alg: 'RS256', typ: 'JWT', ...(key.private_key_id ? { kid: key.private_key_id } : {}) };
  const claims = { iss: key.client_email, scope, aud: TOKEN_URL, iat, exp: iat + LIFETIME_SECONDS };
  const unsigned = `${b64url(header)}.${b64url(claims)}`;
  let signature;
  try {
    signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key, 'base64url');
  } catch {
    throw new CredentialsError('The service account key\'s private_key could not be used to sign (it is not a valid PEM private key). Download the JSON key again.');
  }
  return `${unsigned}.${signature}`;
}

export function createTokenProvider({ key, scope = BIGQUERY_SCOPE, fetch, sleep, random, now = () => Date.now() }) {
  const request = createRequester({ service: 'Google', fetch, sleep, random });
  let cached = null;
  return {
    async token() {
      if (cached && now() < cached.until) return cached.token;
      const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: signedAssertion(key, { scope, now: now() }) }).toString();
      const res = await request(TOKEN_URL, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
      if (res.status < 200 || res.status >= 300) {
        const code = typeof res.body?.error === 'string' && /^[a-z_]+$/.test(res.body.error) ? res.body.error : `status ${res.status}`;
        throw new ApiError(`Google refused the service account key (${code}). Check that the key is current (not deleted in the Google Cloud console), that the machine clock is right, and that the service account exists.`, res.status);
      }
      const t = res.body?.access_token;
      if (typeof t !== 'string' || !t) throw new ApiError('Google\'s token endpoint answered with no access token. Nothing was read or written.', res.status);
      const ttl = Number(res.body.expires_in) > 0 ? Number(res.body.expires_in) : 300;
      cached = { token: t, until: now() + (ttl - 60) * 1000 };
      return t;
    },
  };
}
