import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planWrites, toHubSpot, sameValue, formatPlan } from '../src/plan.mjs';
import { DEFINITIONS } from '../src/definitions.mjs';

const def = (key) => DEFINITIONS.find((d) => d.key === key);
const metrics = (over = {}) => ({ mrr: 400, arr: 4800, currency: 'USD', outstanding_amount: 0, plan: 'Pro', billing_status: 'active', renewal_date: '2026-11-01', seat_count: 10, active_users_30d: null, usage_trend: null, ...over });
const account = (id, name, over = {}, extra = {}) => ({ hubspot_company_id: id, hubspot_company_name: name, metrics: metrics(over), blocked: [], flags: [], ...extra });

test('values are written the way HubSpot stores them', () => {
  assert.equal(toHubSpot(def('mrr'), 83.33), '83.33');
  assert.equal(toHubSpot(def('mrr'), null), '');
  assert.equal(toHubSpot(def('renewal_date'), '2026-11-01'), '2026-11-01');
  assert.equal(toHubSpot(def('plan'), 'Pro'), 'Pro');
});

test('HubSpot values compare by meaning, not by string', () => {
  assert.ok(sameValue(def('mrr'), '1250', '1250.00'));
  assert.ok(sameValue(def('mrr'), '83.33', '83.330'));
  assert.ok(!sameValue(def('mrr'), '83.33', '83.34'));
  assert.ok(sameValue(def('mrr'), null, ''));
  assert.ok(!sameValue(def('mrr'), '0', ''));
  assert.ok(sameValue(def('renewal_date'), '1793577600000', '2026-11-02'));
  assert.ok(sameValue(def('renewal_date'), '2026-11-02T00:00:00Z', '2026-11-02'));
  assert.ok(sameValue(def('plan'), ' Pro ', 'Pro'));
});

test('a company with no revenue-sync values yet gets every property written', () => {
  const r = planWrites({ model: { accounts: [account('101', 'Northwind')] }, current: new Map([['101', {}]]) });
  assert.equal(r.writes.length, 8, 'the two empty usage values match an empty property and are not written');
  assert.deepEqual(r.writes[0], { company_id: '101', company_name: 'Northwind', key: 'mrr', property: 'rs_mrr', old: '', new: '400', edited_since_sync: false });
});

test('a company already in step needs no writes', () => {
  const current = new Map([['101', { rs_mrr: '400', rs_arr: '4800', rs_billing_currency: 'USD', rs_outstanding_amount: '0', rs_plan: 'Pro', rs_billing_status: 'active', rs_renewal_date: '2026-11-01', rs_seat_count: '10', rs_active_users_30d: null, rs_usage_trend: null }]]);
  const r = planWrites({ model: { accounts: [account('101', 'Northwind')] }, current });
  assert.deepEqual(r.writes, []);
});

test('blocked metrics are never written, so a flagged company keeps its last good value', () => {
  const a = account('102', 'Globex', { mrr: null, arr: null, outstanding_amount: null }, { blocked: ['mrr', 'arr', 'outstanding_amount'], flags: [{ code: 'mixed_currency', detail: 'x' }] });
  const r = planWrites({ model: { accounts: [a] }, current: new Map([['102', { rs_mrr: '10' }]]) });
  assert.ok(!r.writes.some((w) => ['rs_mrr', 'rs_arr', 'rs_outstanding_amount'].includes(w.property)));
});

test('a value edited in HubSpot since the last sync is marked, so a hand edit is never overwritten silently', () => {
  const snapshot = { values: { 101: { rs_mrr: '400' } } };
  const r = planWrites({ model: { accounts: [account('101', 'Northwind')] }, current: new Map([['101', { rs_mrr: '999' }]]), snapshot });
  const w = r.writes.find((x) => x.property === 'rs_mrr');
  assert.equal(w.old, '999');
  assert.equal(w.edited_since_sync, true);
  assert.equal(r.writes.find((x) => x.property === 'rs_plan').edited_since_sync, false);
});

test('a company that vanished from HubSpot between reads is skipped and reported', () => {
  const r = planWrites({ model: { accounts: [account('101', 'Northwind')] }, current: new Map() });
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.missing_companies, ['101']);
});

test('the printed plan shows every write as company, property, old to new, plus properties to create', () => {
  const r = planWrites({ model: { accounts: [account('101', 'Northwind', { seat_count: 12 })] }, current: new Map([['101', { rs_mrr: '400', rs_arr: '4800', rs_billing_currency: 'USD', rs_outstanding_amount: '0', rs_plan: 'Pro', rs_billing_status: 'active', rs_renewal_date: '2026-11-01', rs_seat_count: '10' }]]), snapshot: { values: { 101: { rs_seat_count: '9' } } } });
  const text = formatPlan(r, { missingProperties: ['rs_usage_trend'], missingGroup: true });
  assert.match(text, /Would create the property group revenue_sync and 1 property: rs_usage_trend/);
  assert.match(text, /Northwind \(HubSpot 101\)\n {2}rs_seat_count: 10 → 12 \(edited in HubSpot since the last sync\)/);
  assert.match(text, /1 write across 1 company\./);
});

test('an empty old value prints as (empty), and a clean plan says so', () => {
  const r = planWrites({ model: { accounts: [account('101', 'Northwind')] }, current: new Map([['101', {}]]) });
  assert.match(formatPlan(r, { missingProperties: [] }), /rs_mrr: \(empty\) → 400/);
  assert.match(formatPlan({ writes: [], missing_companies: [] }, { missingProperties: [] }), /Nothing to write: HubSpot already matches billing and usage\./);
});

test('three-decimal amounts compare to the thousandth', () => {
  assert.ok(!sameValue(def('mrr'), '12.345', '12.349'));
  assert.ok(sameValue(def('mrr'), '12.345', '12.3450'));
});

test('without a usage source, usage properties are left untouched, never blanked (I4)', () => {
  const model = { sources: { usage: { accounts: 0, provided: false } }, accounts: [account('101', 'Northwind', { active_users_30d: null, usage_trend: null })] };
  const current = new Map([['101', { rs_active_users_30d: '7', rs_usage_trend: 'up' }]]);
  const r = planWrites({ model, current });
  assert.ok(!r.writes.some((w) => ['rs_active_users_30d', 'rs_usage_trend'].includes(w.property)));
});

test('an unlinked company has its values cleared and rs_billing_status set to unlinked (B1)', () => {
  const model = { accounts: [], unlinked: [{ hubspot_company_id: '104', hubspot_company_name: 'Gone Corp', reason: 'r', cleared: false }] };
  const r = planWrites({ model, current: new Map([['104', { rs_mrr: '500', rs_billing_status: 'active', rs_plan: 'Pro' }]]) });
  assert.deepEqual(r.writes.map((w) => `${w.property}:${w.old}:${w.new}`).sort(), ['rs_billing_status:active:unlinked', 'rs_mrr:500:', 'rs_plan:Pro:']);
  const done = planWrites({ model, current: new Map([['104', { rs_billing_status: 'unlinked' }]]) });
  assert.deepEqual(done.writes, []);
});
