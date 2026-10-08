import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validate } from './helpers/schema.mjs';
import { buildModel, MODEL_SCHEMA, MODEL_VERSION } from '../src/model.mjs';
import { DEFINITIONS } from '../src/definitions.mjs';
import { parseMapping } from '../src/mapping.mjs';
import { parseUsage } from '../src/usage.mjs';
import { item, sub, invoice } from './helpers/billing.mjs';

const SCHEMA = JSON.parse(readFileSync(new URL('../schema/account-model.v1.json', import.meta.url), 'utf8'));
const DOC = readFileSync(new URL('../docs/account-model.md', import.meta.url), 'utf8');

function model() {
  const co = (id, name, domain) => ({ id, properties: { name, domain } });
  return buildModel({
    companies: [co('101', 'Northwind', 'northwind.example'), co('102', 'Globex', 'globex.example'), co('103', 'Initech', 'initech.example'), co('104', 'Initech 2', 'initech.example')],
    customers: [{ id: 'cus_1', email: 'a@northwind.example' }, { id: 'cus_2', email: 'b@globex.example' }, { id: 'cus_3', email: 'c@globex.example' }, { id: 'cus_4', email: 'x@gmail.com' }, { id: 'cus_5', email: 'y@initech.example' }],
    subscriptions: [sub({ customer: 'cus_1' }), sub({ customer: 'cus_2' }), sub({ customer: 'cus_3', items: [item({ currency: 'eur' })] })],
    invoices: [invoice({ customer: 'cus_1', remaining: 100 })],
    products: new Map(),
    usage: parseUsage('account_id,user_id,date,domain\nn,u1,2026-10-01,northwind.example\nbad,,2026-10-01,\n'),
    mapping: parseMapping('source,source_id,hubspot_company_id\nstripe,cus_9,1\nstripe,cus_9,2\n'),
    asOf: '2026-10-07',
    generatedAt: new Date('2026-10-07T09:00:00Z'),
  });
}

test('an Accounts v2 refusal fits the published v1 schema (m13)', () => {
  const co = (id, name, domain) => ({ id, properties: { name, domain } });
  const s = sub({ customer: null });
  s.customer_account = 'acct_1V2';
  const m = buildModel({ companies: [co('101', 'Northwind', 'northwind.example')], customers: [], subscriptions: [s], invoices: [], products: new Map(), usage: null, mapping: parseMapping(null), asOf: '2026-10-07', generatedAt: new Date('2026-10-07T09:00:00Z') });
  assert.equal(m.unmatched.length, 1);
  assert.deepEqual(validate(SCHEMA, m, SCHEMA), []);
});

test('a model built from mixed real-world input matches the published v1 schema', () => {
  const m = model();
  assert.ok(m.accounts.length && m.unmatched.length && m.ambiguous.length && m.input_problems.length, 'the sample exercises every list');
  assert.deepEqual(validate(SCHEMA, m, SCHEMA), []);
});

test('the schema file names the same schema id and version as the code', () => {
  assert.equal(SCHEMA.properties.schema.enum[0], MODEL_SCHEMA);
  assert.equal(SCHEMA.properties.version.enum[0], MODEL_VERSION);
});

test('the schema lists exactly the metrics in the definitions file, closed to anything else', () => {
  const metrics = SCHEMA.$defs.metrics;
  assert.deepEqual(Object.keys(metrics.properties).sort(), DEFINITIONS.map((d) => d.key).sort());
  assert.deepEqual([...metrics.required].sort(), DEFINITIONS.map((d) => d.key).sort());
  assert.equal(metrics.additionalProperties, false);
});

test('the validator catches a model that drifts from the schema', () => {
  const m = model();
  m.accounts[0].metrics.health = 3;
  delete m.accounts[0].domain;
  const errors = validate(SCHEMA, m, SCHEMA);
  assert.ok(errors.some((e) => /health is not allowed/.test(e)));
  assert.ok(errors.some((e) => /domain is required/.test(e)));
});

test('docs/account-model.md documents every field in the schema and every metric', () => {
  const fields = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node.properties ?? {})) fields.add(k);
    for (const v of Object.values(node.properties ?? {})) walk(v);
    if (node.items) walk(node.items);
  };
  walk(SCHEMA);
  for (const d of Object.values(SCHEMA.$defs)) walk(d);
  for (const f of fields) assert.ok(DOC.includes(`\`${f}\``), `docs/account-model.md does not mention \`${f}\``);
  assert.match(DOC, /schema\/account-model\.v1\.json/);
  assert.match(DOC, /docs\/metrics\.md/);
});
