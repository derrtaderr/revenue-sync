import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccounts } from '../src/resolve.mjs';
import { parseMapping } from '../src/mapping.mjs';

const co = (id, name, domain, extra = {}) => ({ id, properties: { name, domain, ...extra } });
const companies = [
  co('101', 'Northwind', 'northwind.example', { hs_additional_domains: 'northwind.io' }),
  co('102', 'Globex', 'globex.example'),
  co('103', 'Initech', 'initech.example'),
  co('104', 'Initech (duplicate)', 'www.initech.example'),
];
const mapping = (rows = '') => parseMapping(`source,source_id,hubspot_company_id\n${rows}`);
const run = ({ customers = [], usage = new Map(), map = mapping() } = {}) => resolveAccounts({ companies, customers, usageAccounts: usage, mapping: map });

test('a Stripe customer matches on its email domain, including additional domains', () => {
  const r = run({ customers: [{ id: 'cus_1', email: 'ap@northwind.io' }, { id: 'cus_2', email: 'x@globex.example' }] });
  assert.deepEqual(r.accounts.get('101').stripe_customer_ids, ['cus_1']);
  assert.deepEqual(r.accounts.get('102').stripe_customer_ids, ['cus_2']);
  assert.equal(r.accounts.get('101').matched_by.cus_1, 'domain');
  assert.equal(r.accounts.get('101').company.name, 'Northwind');
  assert.deepEqual(r.unmatched, []);
});

test('metadata.domain on the customer beats its email domain', () => {
  const r = run({ customers: [{ id: 'cus_1', email: 'founder@gmail.com', metadata: { domain: 'globex.example' } }] });
  assert.deepEqual(r.accounts.get('102').stripe_customer_ids, ['cus_1']);
});

test('several Stripe customers on one company all land on it', () => {
  const r = run({ customers: [{ id: 'cus_1', email: 'a@globex.example' }, { id: 'cus_2', email: 'b@globex.example' }] });
  assert.deepEqual(r.accounts.get('102').stripe_customer_ids, ['cus_1', 'cus_2']);
});

test('no company on the domain: unmatched, reported, never guessed', () => {
  const r = run({ customers: [{ id: 'cus_9', email: 'x@unknown.example', name: 'Unknown Ltd' }] });
  assert.equal(r.accounts.size, 0);
  assert.deepEqual(r.unmatched, [{ source: 'stripe', source_id: 'cus_9', label: 'Unknown Ltd', domain: 'unknown.example', reason: 'no HubSpot company has the domain unknown.example' }]);
});

test('a free mail domain never matches, even if a company has it', () => {
  const r = resolveAccounts({ companies: [co('900', 'Google', 'gmail.com')], customers: [{ id: 'cus_3', email: 'ceo@gmail.com' }], usageAccounts: new Map(), mapping: mapping() });
  assert.equal(r.accounts.size, 0);
  assert.match(r.unmatched[0].reason, /gmail\.com is a free mail domain; add a mapping row/);
});

test('no email and no metadata domain: unmatched', () => {
  const r = run({ customers: [{ id: 'cus_4', email: null }] });
  assert.match(r.unmatched[0].reason, /no domain/);
  assert.equal(r.unmatched[0].label, 'cus_4');
});

test('two companies on one domain: refused with both candidates named', () => {
  const r = run({ customers: [{ id: 'cus_5', email: 'x@initech.example' }] });
  assert.equal(r.accounts.size, 0);
  assert.deepEqual(r.ambiguous, [{ source: 'stripe', source_id: 'cus_5', label: 'x@initech.example', domain: 'initech.example', reason: 'two or more HubSpot companies have the domain initech.example', candidates: [{ id: '103', name: 'Initech' }, { id: '104', name: 'Initech (duplicate)' }] }]);
});

test('an explicit mapping wins over domain matching and settles an ambiguous domain', () => {
  const r = run({ customers: [{ id: 'cus_5', email: 'x@initech.example' }, { id: 'cus_6', email: 'y@globex.example' }], map: mapping('stripe,cus_5,104\nstripe,cus_6,101\n') });
  assert.deepEqual(r.accounts.get('104').stripe_customer_ids, ['cus_5']);
  assert.deepEqual(r.accounts.get('101').stripe_customer_ids, ['cus_6']);
  assert.equal(r.accounts.get('101').matched_by.cus_6, 'mapping');
  assert.deepEqual(r.ambiguous, []);
});

test('a mapping that points at a company HubSpot does not have is unmatched', () => {
  const r = run({ customers: [{ id: 'cus_7', email: 'y@globex.example' }], map: mapping('stripe,cus_7,999\n') });
  assert.equal(r.accounts.size, 0);
  assert.match(r.unmatched[0].reason, /mapping file points at HubSpot company 999, which does not exist/);
});

test('a source id the mapping file sends to two companies is ambiguous, not domain-matched', () => {
  const r = run({ customers: [{ id: 'cus_8', email: 'y@globex.example' }], map: mapping('stripe,cus_8,101\nstripe,cus_8,102\n') });
  assert.equal(r.accounts.size, 0);
  assert.deepEqual(r.ambiguous[0].candidates, [{ id: '101', name: 'Northwind' }, { id: '102', name: 'Globex' }]);
  assert.match(r.ambiguous[0].reason, /mapping file/);
});

test('usage accounts resolve the same way: mapping, then their domain column', () => {
  const usage = new Map([
    ['acct_1', { account_id: 'acct_1', domain: 'northwind.example', events: [] }],
    ['acct_2', { account_id: 'acct_2', domain: null, events: [] }],
    ['acct_3', { account_id: 'acct_3', domain: null, events: [] }],
  ]);
  const r = run({ usage, map: mapping('usage,acct_3,102\n') });
  assert.deepEqual(r.accounts.get('101').usage_account_ids, ['acct_1']);
  assert.deepEqual(r.accounts.get('102').usage_account_ids, ['acct_3']);
  assert.equal(r.unmatched[0].source, 'usage');
  assert.equal(r.unmatched[0].source_id, 'acct_2');
});
