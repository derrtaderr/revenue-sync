import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMapping } from '../src/mapping.mjs';

test('reads explicit stripe and usage mappings to HubSpot company ids', () => {
  const m = parseMapping('source,source_id,hubspot_company_id\nstripe,cus_1,101\nusage,acct_9,101\n');
  assert.equal(m.lookup('stripe', 'cus_1'), '101');
  assert.equal(m.lookup('usage', 'acct_9'), '101');
  assert.equal(m.lookup('stripe', 'cus_2'), null);
  assert.deepEqual(m.problems, []);
});

test('source is case-insensitive; unknown sources and non-numeric company ids are reported', () => {
  const m = parseMapping('source,source_id,hubspot_company_id\nSTRIPE,cus_1,101\nchargebee,x,1\nstripe,cus_2,abc\nstripe,,5\n');
  assert.equal(m.lookup('stripe', 'cus_1'), '101');
  assert.deepEqual(m.problems.map((p) => p.line), [3, 4, 5]);
});

test('one source id mapped to two companies is refused, both rows named', () => {
  const m = parseMapping('source,source_id,hubspot_company_id\nstripe,cus_1,101\nstripe,cus_1,202\n');
  assert.equal(m.lookup('stripe', 'cus_1'), null);
  assert.equal(m.conflicts.length, 1);
  assert.deepEqual(m.conflicts[0], { source: 'stripe', source_id: 'cus_1', company_ids: ['101', '202'] });
});

test('the same mapping twice is fine', () => {
  const m = parseMapping('source,source_id,hubspot_company_id\nstripe,cus_1,101\nstripe,cus_1,101\n');
  assert.equal(m.lookup('stripe', 'cus_1'), '101');
  assert.deepEqual(m.conflicts, []);
});

test('no mapping file means an empty mapping', () => {
  const m = parseMapping(null);
  assert.equal(m.lookup('stripe', 'x'), null);
});

test('wrong columns stop with a plain message', () => {
  assert.throws(() => parseMapping('a,b\n1,2\n'), /mapping CSV needs the columns source, source_id, hubspot_company_id/);
});
