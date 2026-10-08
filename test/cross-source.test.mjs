import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareSources, formatCrossSource } from '../src/cross-source.mjs';

const acct = (id, name, mrr, currency = 'USD', flags = []) => ({ hubspot_company_id: id, hubspot_company_name: name, metrics: { mrr, currency }, blocked: flags.length ? ['mrr', 'arr', 'outstanding_amount'] : [], flags });
const model = (...accounts) => ({ accounts });

test('the same MRR and currency in both sources: nothing disagrees', () => {
  const r = compareSources({ warehouse: model(acct('1', 'Northwind', 1300), acct('2', 'Globex', 2000)), stripe: model(acct('1', 'Northwind', 1300.0004), acct('2', 'Globex', 2000)) });
  assert.deepEqual(r.disagreements, []);
  assert.equal(r.compared, 2);
  assert.equal(r.ok, true);
});

test('a company whose warehouse MRR differs from Stripe is named with both values', () => {
  const r = compareSources({ warehouse: model(acct('1', 'Northwind', 1560)), stripe: model(acct('1', 'Northwind', 1300)) });
  assert.equal(r.ok, false);
  assert.deepEqual(r.disagreements, [{ company_id: '1', company_name: 'Northwind', warehouse: { mrr: 1560, currency: 'USD' }, stripe: { mrr: 1300, currency: 'USD' } }]);
});

test('the same amount in another currency disagrees', () => {
  assert.equal(compareSources({ warehouse: model(acct('1', 'N', 100, 'EUR')), stripe: model(acct('1', 'N', 100, 'USD')) }).disagreements.length, 1);
});

test('a company in only one source disagrees unless its MRR there is 0', () => {
  const r = compareSources({ warehouse: model(acct('1', 'Northwind', 1300), acct('3', 'Vandelay', 0, null)), stripe: model() });
  assert.deepEqual(r.disagreements.map((d) => [d.company_id, d.warehouse?.mrr ?? null, d.stripe]), [['1', 1300, null]]);
  assert.equal(compareSources({ warehouse: model(), stripe: model(acct('9', 'Hooli', 250)) }).disagreements[0].warehouse, null);
});

test('a company flagged in either source is not compared, and says where it was flagged', () => {
  const flags = [{ code: 'mixed_currency', detail: 'EUR and USD' }];
  const r = compareSources({ warehouse: model(acct('7', 'Stark', null, null, flags)), stripe: model(acct('7', 'Stark', 50)) });
  assert.equal(r.ok, false, 'its only company was not compared, so nothing was shown to agree (m1)');
  assert.deepEqual(r.notCompared, [{ company_id: '7', company_name: 'Stark', reason: 'flagged in the warehouse: EUR and USD' }]);
});

test('the report names every disagreement with both values, and what was not compared', () => {
  const r = compareSources({
    warehouse: model(acct('1', 'Northwind', 1560), acct('2', 'Globex', 2000), acct('7', 'Stark', null, null, [{ code: 'mixed_currency', detail: 'EUR and USD' }])),
    stripe: model(acct('1', 'Northwind', 1300), acct('2', 'Globex', 2000), acct('9', 'Hooli', 250)),
  });
  assert.equal(formatCrossSource(r), [
    'Warehouse and Stripe disagree on MRR for 2 companies.',
    '',
    'Northwind (HubSpot 1): warehouse says 1560 USD, Stripe says 1300 USD',
    'Hooli (HubSpot 9): warehouse has no record, Stripe says 250 USD',
    'Not compared: Stark (HubSpot 7): flagged in the warehouse: EUR and USD',
    '',
    'Cross-source check failed: the warehouse billing data and Stripe disagree. A warehouse load behind Stripe (Stripe Data Pipeline loads every 3 hours) is the usual cause; if it persists, check the billing SQL.',
    '',
  ].join('\n'));
  assert.equal(formatCrossSource(compareSources({ warehouse: model(acct('2', 'Globex', 2000)), stripe: model(acct('2', 'Globex', 2000)) })), 'Warehouse and Stripe agree on MRR: 1 of 1 company compared.\n');
});

test('m1: when every company is flagged on one side, nothing was compared, and that is not agreement', () => {
  const flags = [{ code: 'tax_inclusive_price', detail: 'tax-inclusive price' }];
  const r = compareSources({ warehouse: model(acct('1', 'Northwind', null, null, flags)), stripe: model(acct('1', 'Northwind', 1300)) });
  assert.equal(r.ok, false);
  assert.equal(r.compared, 0);
  assert.match(formatCrossSource(r), /Cross-source check compared nothing: every company is flagged on one side or the other \(1 listed above\), so the warehouse and Stripe were not shown to agree\./);
  const empty = compareSources({ warehouse: model(), stripe: model() });
  assert.equal(empty.ok, false);
  assert.match(formatCrossSource(empty), /compared nothing: neither source has a company/);
});

test('m1: agreement says how many of the companies were compared', () => {
  const r = compareSources({ warehouse: model(acct('1', 'N', 10), acct('7', 'S', null, null, [{ code: 'x', detail: 'y' }])), stripe: model(acct('1', 'N', 10), acct('7', 'S', 5)) });
  assert.match(formatCrossSource(r), /Warehouse and Stripe agree on MRR: 1 of 2 companies compared\./);
});
