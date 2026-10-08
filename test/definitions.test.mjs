import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFINITIONS, PROPERTY_GROUP } from '../src/definitions.mjs';

const VALID = { number: ['number'], date: ['date'], string: ['text'] };

test('there is one definition per metric the row names, each with a unique key and property', () => {
  const keys = DEFINITIONS.map((d) => d.key);
  for (const k of ['mrr', 'arr', 'plan', 'renewal_date', 'seat_count', 'active_users_30d', 'usage_trend']) assert.ok(keys.includes(k), k);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(new Set(DEFINITIONS.map((d) => d.property)).size, keys.length);
});

test('every property is prefixed rs_, lower snake case, with a valid HubSpot type and field type', () => {
  for (const d of DEFINITIONS) {
    assert.match(d.property, /^rs_[a-z0-9_]+$/, d.key);
    assert.ok(VALID[d.type]?.includes(d.fieldType), `${d.key}: ${d.type}/${d.fieldType}`);
    assert.ok(d.label && d.label.length <= 40, d.key);
  }
});

test('every definition says in plain words what it means, without em dashes', () => {
  for (const d of DEFINITIONS) {
    assert.equal(typeof d.description, 'string', d.key);
    assert.ok(d.description.length >= 60, `${d.key} needs a real description`);
    assert.ok(!d.description.includes('—'), `${d.key} has an em dash`);
    assert.ok(/[.]$/.test(d.description), `${d.key} description ends with a full stop`);
  }
});

test('the properties live in one named group', () => {
  assert.deepEqual(PROPERTY_GROUP, { name: 'revenue_sync', label: 'Revenue sync' });
});
