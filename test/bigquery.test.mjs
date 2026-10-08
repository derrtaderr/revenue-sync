import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeRows } from '../src/bigquery.mjs';

const f = (name, type, mode = 'NULLABLE', fields) => ({ name, type, mode, ...(fields ? { fields } : {}) });
const row = (...vs) => ({ f: vs.map((v) => ({ v })) });

test('scalar values decode by schema type: INT64, NUMERIC and BIGNUMERIC stay exact strings, TIMESTAMP is float seconds', () => {
  const fields = [f('s', 'STRING'), f('i', 'INTEGER'), f('i2', 'INT64'), f('n', 'NUMERIC'), f('bn', 'BIGNUMERIC'), f('x', 'FLOAT'), f('b', 'BOOLEAN'), f('b2', 'BOOL'), f('t', 'TIMESTAMP'), f('d', 'DATE'), f('dt', 'DATETIME')];
  const [r] = decodeRows(fields, [row('cus_1', '9007199254740993', '-4', '1234.5', '123456789012345678901234567890.5', '1.5', 'true', 'false', '1.7914752E9', '2026-10-07', '2026-10-07T09:00:00')]);
  assert.deepEqual(r, { s: 'cus_1', i: '9007199254740993', i2: '-4', n: '1234.5', bn: '123456789012345678901234567890.5', x: 1.5, b: true, b2: false, t: 1791475200, d: '2026-10-07', dt: '2026-10-07T09:00:00' });
});

test('NULL is {v: null} for every type', () => {
  const fields = ['STRING', 'INT64', 'NUMERIC', 'FLOAT64', 'BOOL', 'TIMESTAMP', 'DATE'].map((t, i) => f(`c${i}`, t));
  const [r] = decodeRows(fields, [row(null, null, null, null, null, null, null)]);
  assert.ok(Object.values(r).every((v) => v === null));
});

test('REPEATED is {v: [{v}]} and RECORD is {v: {f: [...]}}', () => {
  const fields = [f('tags', 'STRING', 'REPEATED'), f('rec', 'RECORD', 'NULLABLE', [f('a', 'INT64'), f('b', 'STRING')]), f('recs', 'RECORD', 'REPEATED', [f('a', 'INT64')])];
  const [r] = decodeRows(fields, [row([{ v: 'x' }, { v: 'y' }], { f: [{ v: '1' }, { v: null }] }, [{ v: { f: [{ v: '2' }] } }])]);
  assert.deepEqual(r, { tags: ['x', 'y'], rec: { a: '1', b: null }, recs: [{ a: '2' }] });
});

test('a value that is not what its type promises throws, naming the row and column', () => {
  for (const [type, v] of [['INT64', '1.5'], ['INT64', 'abc'], ['NUMERIC', '1e5x'], ['BOOL', 'yes'], ['TIMESTAMP', 'soon'], ['DATE', '07/10/2026'], ['STRING', 5]]) {
    assert.throws(() => decodeRows([f('c', type)], [row(v)]), (err) => err.name === 'ApiError' && /row 1, column c/.test(err.message), `${type} ${v}`);
  }
});

test('a malformed row or schema throws instead of reading short', () => {
  assert.throws(() => decodeRows([f('a', 'STRING'), f('b', 'STRING')], [row('x')]), /row 1 has 1 values, the schema has 2/);
  assert.throws(() => decodeRows([f('a', 'STRING')], [{ v: 'x' }]), /row 1 is not in BigQuery's \{f: \[\.\.\.\]\} shape/);
  assert.throws(() => decodeRows([f('a', 'RANGE')], [row('x')]), /column a has type RANGE, which this tool does not read/);
  assert.throws(() => decodeRows([f('a', 'STRING'), f('a', 'STRING')], []), /column a appears twice/);
  assert.throws(() => decodeRows(null, []), /no schema/);
});

// ---- the client: jobs.query, getQueryResults paging and polling, fail-closed reads ----
import { createBigQueryClient, MAX_POLLS } from '../src/bigquery.mjs';
import { createTokenProvider } from '../src/google-auth.mjs';
import { createFakeBigQuery } from './helpers/fake-bigquery.mjs';
import { serviceAccountKey } from './helpers/google-key.mjs';

const NOW = Date.UTC(2026, 9, 7, 9);
const QUERIES = '/bigquery/v2/projects/demo-project/queries';
const SQL = 'select customer_id, amount from billing';
const FIELDS = [f('customer_id', 'STRING'), f('amount', 'NUMERIC')];
const ROWS = [['cus_1', '1000'], ['cus_2', null], ['cus_3', '250'], ['cus_4', '1'], ['cus_5', '2']];
const reply = (status, body) => () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function bq({ result = { fields: FIELDS, rows: ROWS }, location = 'US' } = {}) {
  const { json, publicKey } = serviceAccountKey();
  const fake = createFakeBigQuery({ key: json, publicKey, now: () => NOW });
  fake.results.set(SQL, result);
  const io = { fetch: fake.fetch, sleep: async () => {}, random: () => 0 };
  const tokens = createTokenProvider({ key: json, now: () => NOW, ...io });
  return { fake, client: createBigQueryClient({ tokens, project: 'demo-project', location, ...io }) };
}

test('a query runs as GoogleSQL in the given location with the bearer token, and returns decoded rows', async () => {
  const { fake, client } = bq();
  const r = await client.query(SQL);
  assert.deepEqual(r.rows.map((x) => x.customer_id), ['cus_1', 'cus_2', 'cus_3', 'cus_4', 'cus_5']);
  assert.equal(r.rows[1].amount, null);
  assert.deepEqual(r.fields.map((x) => x.name), ['customer_id', 'amount']);
  const post = fake.requests.find((x) => x.path === QUERIES);
  const body = JSON.parse(post.body);
  assert.equal(body.useLegacySql, false, 'the API default is legacy SQL');
  assert.equal(body.location, 'US');
  assert.equal(body.query, SQL);
  assert.match(post.headers.authorization, /^Bearer ya29\./);
});

test('an empty result is empty only when BigQuery says so: jobComplete true, totalRows "0", rows omitted', async () => {
  const { client } = bq({ result: { fields: FIELDS, rows: [] } });
  assert.deepEqual((await client.query(SQL)).rows, []);
});

test('jobComplete false is polled with getQueryResults until complete', async () => {
  const { fake, client } = bq({ result: { fields: FIELDS, rows: ROWS, pending: 2 } });
  assert.equal((await client.query(SQL)).rows.length, 5);
  const polls = fake.requests.filter((x) => x.method === 'GET');
  assert.equal(polls.length, 2, 'the query answer and one poll are incomplete, the second poll completes');
  assert.match(polls[0].query, /location=US/);
});

test('a job still incomplete after the bounded wait stops the run', async () => {
  const { client } = bq({ result: { fields: FIELDS, rows: ROWS, pending: MAX_POLLS + 5 } });
  await assert.rejects(client.query(SQL), /still running after/);
});

test('multi-page results are read to the end with pageToken', async () => {
  const { fake, client } = bq({ result: { fields: FIELDS, rows: ROWS, pageSize: 2 } });
  assert.deepEqual((await client.query(SQL)).rows.map((x) => x.customer_id), ['cus_1', 'cus_2', 'cus_3', 'cus_4', 'cus_5']);
  assert.deepEqual(fake.requests.filter((x) => x.method === 'GET').map((x) => new URLSearchParams(x.query).get('pageToken')), ['page-2', 'page-4']);
});

const complete = (over) => ({ kind: 'bigquery#queryResponse', jobReference: { projectId: 'demo-project', jobId: 'job_x', location: 'US' }, jobComplete: true, schema: { fields: FIELDS }, ...over });

test('fail closed: rows missing while totalRows says there are some', async () => {
  const { fake, client } = bq();
  fake.failures[`POST ${QUERIES}`] = ['pass', reply(200, complete({ totalRows: '5' }))];
  await assert.rejects(client.query(SQL), /totalRows says 5 but sent no rows/);
});

test('fail closed: fewer rows than totalRows, a repeated pageToken, no schema, no totalRows', async () => {
  const cases = [
    [complete({ totalRows: '3', rows: [{ f: [{ v: 'cus_1' }, { v: '1' }] }] }), /1 of 3 rows/],
    [complete({ totalRows: '1' }), /totalRows says 1 but sent no rows/],
    [complete({ schema: undefined, totalRows: '0' }), /no schema/],
    [complete({ totalRows: undefined }), /no totalRows/],
  ];
  for (const [body, re] of cases) {
    const { fake, client } = bq();
    fake.failures[`POST ${QUERIES}`] = ['pass', reply(200, body)];
    await assert.rejects(client.query(SQL), re);
  }
  const { fake, client } = bq();
  const page = complete({ totalRows: '4', rows: [{ f: [{ v: 'a' }, { v: '1' }] }], pageToken: 'same' });
  fake.failures[`POST ${QUERIES}`] = ['pass', reply(200, page)];
  fake.failures['GET /bigquery/v2/projects/demo-project/queries/job_x'] = [reply(200, page)];
  await assert.rejects(client.query(SQL), /same pageToken twice/);
});

test('fail closed: any errors entry in a 200 answer is a failed job', async () => {
  const { fake, client } = bq();
  fake.failures[`POST ${QUERIES}`] = ['pass', reply(200, complete({ totalRows: '0', errors: [{ reason: 'stopped', message: 'Job execution was cancelled' }] }))];
  await assert.rejects(client.query(SQL), /reported an error running the query \(stopped\)/);
});

test('a query error shows Google\'s message about the SQL, and never the token', async () => {
  const { fake, client } = bq();
  fake.results.delete(SQL);
  await assert.rejects(client.query(SQL), (err) => {
    assert.equal(err.name, 'ApiError');
    assert.match(err.message, /BigQuery refused the query \(400, invalidQuery\): Unrecognized name: no_such_table at \[1:15\]/);
    assert.doesNotMatch(err.message, /ya29/);
    return true;
  });
  assert.ok(fake.tokens.size > 0);
});

test('access denied names the roles the service account needs', async () => {
  const { fake, client } = bq();
  fake.failures[`POST ${QUERIES}`] = ['pass', reply(403, { error: { code: 403, message: 'Access Denied: Project demo-project: User does not have bigquery.jobs.create permission', errors: [{ reason: 'accessDenied', message: 'x' }] } })];
  await assert.rejects(client.query(SQL), /BigQuery Job User.*BigQuery Data Viewer/);
});

test('m-C: a 403 whose reason says the token scope is insufficient says token scope, not the IAM roles', async () => {
  const scopeMessage = 'Request had insufficient authentication scopes.';
  const shapes = [
    // The legacy errors[] reason, and the google.rpc.ErrorInfo detail (cloud.google.com/apis/design/errors).
    { code: 403, message: scopeMessage, status: 'PERMISSION_DENIED', errors: [{ reason: 'insufficientPermissions', message: scopeMessage, domain: 'global' }] },
    { code: 403, message: scopeMessage, status: 'PERMISSION_DENIED', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', domain: 'googleapis.com' }] },
  ];
  for (const error of shapes) {
    const { fake, client } = bq();
    fake.failures[`POST ${QUERIES}`] = ['pass', reply(403, { error })];
    await assert.rejects(client.query(SQL), (err) => {
      assert.match(err.message, /token scope/);
      assert.doesNotMatch(err.message, /BigQuery Job User|BigQuery Data Viewer/);
      return true;
    });
  }
});

test('m-C: a permission-denied 403 keeps the IAM roles hint', async () => {
  const { fake, client } = bq();
  fake.failures[`POST ${QUERIES}`] = ['pass', reply(403, { error: { code: 403, message: 'Access Denied: Project demo-project: User does not have bigquery.jobs.create permission', status: 'PERMISSION_DENIED', errors: [{ reason: 'accessDenied', message: 'x' }] } })];
  await assert.rejects(client.query(SQL), (err) => {
    assert.match(err.message, /BigQuery Job User.*BigQuery Data Viewer/);
    assert.doesNotMatch(err.message, /token scope/);
    return true;
  });
});

test('a 403 for a Drive or Sheets backed table says such tables are not supported, not the IAM roles', async () => {
  const { fake, client } = bq();
  const message = 'Access Denied: BigQuery BigQuery: Permission denied while getting Drive credentials.';
  fake.failures[`POST ${QUERIES}`] = ['pass', reply(403, { error: { code: 403, message, status: 'PERMISSION_DENIED', errors: [{ reason: 'accessDenied', message, domain: 'global' }] } })];
  await assert.rejects(client.query(SQL), (err) => {
    assert.match(err.message, /backed by Google Drive or Sheets/);
    assert.match(err.message, /not supported/);
    assert.doesNotMatch(err.message, /BigQuery Job User|BigQuery Data Viewer/);
    return true;
  });
});

test('a 5xx is retried by the shared HTTP layer', async () => {
  const { fake, client } = bq();
  fake.failures[`POST ${QUERIES}`] = ['pass', 503, 500];
  assert.equal((await client.query(SQL)).rows.length, 5);
});

// ---- the SQL may only read (I4), and a retried query is one request (m3) ----

test('I4: the SQL is dry-run first, and anything that is not a SELECT is refused before it runs', async () => {
  for (const type of ['INSERT', 'DELETE', 'CREATE_TABLE', 'SCRIPT', 'MERGE']) {
    const { fake, client } = bq({ result: { fields: FIELDS, rows: ROWS, statementType: type } });
    await assert.rejects(client.query(SQL), new RegExp(`only runs a SELECT; BigQuery says this SQL is ${type}`));
    const posts = fake.requests.filter((x) => x.path === QUERIES).map((x) => JSON.parse(x.body));
    assert.deepEqual(posts.map((b) => b.dryRun === true), [true], `${type}: only the dry run was sent`);
  }
});

test('I4: a dry-run answer that does not say what the statement is refuses to run it', async () => {
  const { fake, client } = bq();
  fake.failures[`POST ${QUERIES}`] = [reply(200, { kind: 'bigquery#queryResponse', jobComplete: true, totalBytesProcessed: '0' })];
  await assert.rejects(client.query(SQL), /did not say what kind of statement/);
});

test('I4: a SELECT dry-runs, then runs once with useLegacySql false', async () => {
  const { fake, client } = bq();
  assert.equal((await client.query(SQL)).rows.length, 5);
  const posts = fake.requests.filter((x) => x.path === QUERIES).map((x) => JSON.parse(x.body));
  assert.deepEqual(posts.map((b) => [b.dryRun === true, b.useLegacySql]), [[true, false], [false, false]]);
});

test('m3: the query carries a requestId, and a retry after a 5xx sends the same one', async () => {
  const { fake, client } = bq();
  fake.failures[`POST ${QUERIES}`] = ['pass', 503];
  assert.equal((await client.query(SQL)).rows.length, 5);
  const ids = fake.requests.filter((x) => x.path === QUERIES && !JSON.parse(x.body).dryRun).map((x) => JSON.parse(x.body).requestId);
  assert.equal(ids.length, 2, 'the 503 attempt and the retry');
  assert.equal(ids[0], ids[1]);
  assert.match(ids[0], /^[0-9a-f-]{36}$/);
});
