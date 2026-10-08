import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequester, ApiError } from '../src/http.mjs';

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function scripted(responses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses.shift();
    return typeof next === 'function' ? next() : next;
  };
  return { fetch, calls };
}

function sleeper() {
  const waits = [];
  return { sleep: async (ms) => { waits.push(ms); }, waits };
}

const make = (responses, opts = {}) => {
  const f = scripted(responses);
  const s = sleeper();
  const request = createRequester({ service: 'Stripe', fetch: f.fetch, sleep: s.sleep, random: () => 0, ...opts });
  return { request, calls: f.calls, waits: s.waits };
};

test('returns status and parsed body on success', async () => {
  const { request } = make([json(200, { ok: 1 })]);
  const r = await request('https://api.example.test/v1/x', { method: 'GET' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { ok: 1 });
});

test('a 429 with Retry-After waits that long, then succeeds', async () => {
  const { request, waits, calls } = make([json(429, {}, { 'retry-after': '2' }), json(200, { ok: 1 })]);
  const r = await request('https://api.example.test/v1/x');
  assert.equal(r.status, 200);
  assert.deepEqual(waits, [2000]);
  assert.equal(calls.length, 2);
});

test('5xx backs off exponentially (with jitter from the injected random)', async () => {
  const { request, waits } = make([json(500, {}), json(502, {}), json(503, {}), json(200, {})]);
  await request('https://api.example.test/v1/x');
  assert.deepEqual(waits, [500, 1000, 2000]);
});

test('jitter adds up to the same again on top of the base wait', async () => {
  const { request, waits } = make([json(500, {}), json(200, {})], { random: () => 0.5 });
  await request('https://api.example.test/v1/x');
  assert.deepEqual(waits, [750]);
});

test('gives up after 5 retries with an error naming the service, status and path, never the body', async () => {
  const { request, calls } = make(Array.from({ length: 6 }, () => json(429, { message: 'secret-body' })));
  await assert.rejects(request('https://api.example.test/v1/customers?limit=100'), (err) => {
    assert.ok(err instanceof ApiError);
    assert.equal(err.status, 429);
    assert.match(err.message, /Stripe/);
    assert.match(err.message, /\/v1\/customers/);
    assert.doesNotMatch(err.message, /secret-body|limit=100/);
    return true;
  });
  assert.equal(calls.length, 6);
});

test('refuses to wait longer than 60 seconds for a Retry-After', async () => {
  const { request, waits } = make([json(429, {}, { 'retry-after': '120' })]);
  await assert.rejects(request('https://api.example.test/v1/x'), /asked to wait 120 seconds/);
  assert.deepEqual(waits, []);
});

test('network errors are retried, then reported plainly', async () => {
  const boom = () => { throw new TypeError('connect ECONNREFUSED secret'); };
  const { request } = make(Array.from({ length: 6 }, () => boom));
  await assert.rejects(request('https://api.example.test/v1/x'), (err) => {
    assert.match(err.message, /Could not reach Stripe/);
    assert.doesNotMatch(err.message, /secret/);
    return true;
  });
});

test('a success that is not JSON is an error', async () => {
  const { request } = make([new Response('<html>', { status: 200 })]);
  await assert.rejects(request('https://api.example.test/v1/x'), /not valid JSON/);
});

test('a non-retryable status is returned to the caller with its parsed body', async () => {
  const { request, calls } = make([json(404, { error: { type: 'invalid_request_error' } })]);
  const r = await request('https://api.example.test/v1/x');
  assert.equal(r.status, 404);
  assert.equal(r.body.error.type, 'invalid_request_error');
  assert.equal(calls.length, 1);
});

test('a non-retryable status with a non-JSON body returns a null body', async () => {
  const { request } = make([new Response('nope', { status: 401 })]);
  const r = await request('https://api.example.test/v1/x');
  assert.equal(r.status, 401);
  assert.equal(r.body, null);
});
