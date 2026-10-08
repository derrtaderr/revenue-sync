import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile, formatReconcile } from '../src/reconcile.mjs';

const metrics = (over = {}) => ({ mrr: 400, arr: 4800, currency: 'USD', outstanding_amount: 0, plan: 'Pro', billing_status: 'active', renewal_date: '2026-11-01', seat_count: 10, active_users_30d: 7, usage_trend: 'up', ...over });
const props = (over = {}) => ({ rs_mrr: '400', rs_arr: '4800', rs_billing_currency: 'USD', rs_outstanding_amount: '0', rs_plan: 'Pro', rs_billing_status: 'active', rs_renewal_date: '2026-11-01', rs_seat_count: '10', rs_active_users_30d: '7', rs_usage_trend: 'up', ...over });
const acct = (id, name, m = {}, extra = {}) => ({ hubspot_company_id: id, hubspot_company_name: name, metrics: metrics(m), blocked: [], flags: [], ...extra });
const model = (accounts, extra = {}) => ({ accounts, unmatched: [], ambiguous: [], input_problems: [], ...extra });

test('passes when every CRM value agrees with billing and usage', () => {
  const r = reconcile({ model: model([acct('101', 'Northwind')]), current: new Map([['101', props()]]) });
  assert.equal(r.ok, true);
  assert.equal(r.checked.values, 10);
  assert.match(formatReconcile(r), /Reconciled: 1 company, 10 values\. HubSpot agrees with billing and usage\./);
});

test('fails naming every disagreeing company and property, with both numbers', () => {
  const current = new Map([['101', props({ rs_mrr: '999', rs_seat_count: '12' })], ['102', props({ rs_renewal_date: '' })]]);
  const r = reconcile({ model: model([acct('101', 'Northwind'), acct('102', 'Globex')]), current });
  assert.equal(r.ok, false);
  assert.deepEqual(r.disagreements.map((d) => `${d.company_name}:${d.property}:${d.crm}:${d.billing}`), ['Northwind:rs_mrr:999:400', 'Northwind:rs_seat_count:12:10', 'Globex:rs_renewal_date::2026-11-01']);
  const text = formatReconcile(r);
  assert.match(text, /3 values disagree across 2 companies\./);
  assert.match(text, /Northwind \(HubSpot 101\)\n {2}MRR \(rs_mrr\): HubSpot says 999, billing says 400/);
  assert.match(text, /Renewal date \(rs_renewal_date\): HubSpot says \(empty\), billing says 2026-11-01/);
});

test('a property that does not exist in HubSpot yet reads as empty and disagrees', () => {
  const r = reconcile({ model: model([acct('101', 'Northwind')]), current: new Map([['101', {}]]) });
  assert.equal(r.ok, false);
  assert.ok(r.disagreements.some((d) => d.property === 'rs_mrr'));
});

test('blocked metrics are not compared, and flagged companies are listed as not checked', () => {
  const a = acct('101', 'Globex', { mrr: null, arr: null, outstanding_amount: null }, { blocked: ['mrr', 'arr', 'outstanding_amount'], flags: [{ code: 'mixed_currency', detail: 'subscriptions and open invoices are in EUR and USD' }] });
  const r = reconcile({ model: model([a]), current: new Map([['101', props({ rs_mrr: '1' })]]) });
  assert.equal(r.ok, true);
  assert.match(formatReconcile(r), /Not checked: Globex \(HubSpot 101\) MRR, ARR, Outstanding amount: subscriptions and open invoices are in EUR and USD/);
});

test('a company deleted from HubSpot fails the check', () => {
  const r = reconcile({ model: model([acct('101', 'Northwind')]), current: new Map() });
  assert.equal(r.ok, false);
  assert.match(formatReconcile(r), /Northwind \(HubSpot 101\) is in the account model but HubSpot no longer has it/);
});

test('unmatched and ambiguous records are reported; they fail the check only with --strict', () => {
  const m = model([acct('101', 'Northwind')], {
    unmatched: [{ source: 'stripe', source_id: 'cus_9', label: 'Solo', domain: 'gmail.com', reason: 'gmail.com is a free mail domain; add a mapping row' }],
    ambiguous: [{ source: 'stripe', source_id: 'cus_5', label: 'x', domain: 'initech.example', reason: 'r', candidates: [{ id: '103', name: 'Initech' }, { id: '104', name: 'Initech 2' }] }],
  });
  const current = new Map([['101', props()]]);
  const loose = reconcile({ model: m, current });
  assert.equal(loose.ok, true);
  const text = formatReconcile(loose);
  assert.match(text, /Refused, never written: stripe cus_9 \(Solo\): gmail\.com is a free mail domain/);
  assert.match(text, /Refused, never written: stripe cus_5 \(x\): matches Initech \(103\) and Initech 2 \(104\)/);
  assert.equal(reconcile({ model: m, current, strict: true }).ok, false);
});

test('without a usage source, usage values are not compared and the report says so (I4)', () => {
  const m = model([acct('101', 'Northwind', { active_users_30d: null, usage_trend: null })], { sources: { usage: { accounts: 0, provided: false } } });
  const r = reconcile({ model: m, current: new Map([['101', props()]]) });
  assert.equal(r.ok, true);
  assert.equal(r.checked.values, 8);
  assert.match(formatReconcile(r), /Usage values were not checked: no usage source was given \(--usage or --usage-sql\)\./);
});

test('a company still holding values for a link that is gone fails reconcile, naming both values (B1)', () => {
  const m = model([], { unlinked: [{ hubspot_company_id: '104', hubspot_company_name: 'Gone Corp', reason: 'no Stripe customer or usage account resolves to it any more', cleared: false }] });
  const r = reconcile({ model: m, current: new Map([['104', { rs_mrr: '500', rs_billing_status: 'active' }]]) });
  assert.equal(r.ok, false);
  const text = formatReconcile(r);
  assert.match(text, /Gone Corp \(HubSpot 104\), no longer linked: no Stripe customer or usage account resolves to it any more\n {2}MRR \(rs_mrr\): HubSpot says 500, billing says \(empty\)\n {2}Billing status \(rs_billing_status\): HubSpot says active, billing says unlinked/);
});

test('an unlinked company already cleared passes reconcile but is listed, and fails --strict', () => {
  const m = model([], { unlinked: [{ hubspot_company_id: '104', hubspot_company_name: 'Gone Corp', reason: 'gone', cleared: true }] });
  const current = new Map([['104', { rs_billing_status: 'unlinked' }]]);
  const r = reconcile({ model: m, current });
  assert.equal(r.ok, true);
  assert.match(formatReconcile(r), /Unlinked, values cleared: Gone Corp \(HubSpot 104\): gone/);
  assert.equal(reconcile({ model: m, current, strict: true }).ok, false);
});

test('the verdict never claims agreement when something was not checked (I1)', () => {
  const flagged = acct('102', 'Globex', { mrr: null, arr: null, outstanding_amount: null }, { blocked: ['mrr', 'arr', 'outstanding_amount'], flags: [{ code: 'mixed_currency', detail: 'x' }] });
  const m = model([acct('101', 'Northwind'), flagged], { unmatched: [{ source: 'stripe', source_id: 'cus_9', label: 'S', domain: null, reason: 'r' }] });
  const r = reconcile({ model: m, current: new Map([['101', props()], ['102', props({ rs_mrr: '1' })]]) });
  assert.equal(r.ok, true);
  const text = formatReconcile(r);
  assert.doesNotMatch(text, /HubSpot agrees/);
  assert.match(text, /Checked values agree: 2 companies, 17 values\. Not checked: 1 flagged company, 1 unmatched record\. Exit 0; --strict makes these fail\./);
});

test('usage disagreements are labelled as usage, not billing (m4)', () => {
  const r = reconcile({ model: model([acct('101', 'Northwind')]), current: new Map([['101', props({ rs_usage_trend: 'down' })]]) });
  assert.match(formatReconcile(r), /Usage trend \(rs_usage_trend\): HubSpot says down, usage says up/);
});

test('a failed reconcile run without the mapping file the last sync used says to re-run with it, not to plan and sync (pre-public review I3)', () => {
  const r = reconcile({ model: model([acct('101', 'Northwind')]), current: new Map([['101', props({ rs_mrr: '999' })]]) });
  const text = formatReconcile(r, { missingMapping: true });
  assert.doesNotMatch(text, /Run plan to see the writes/);
  assert.match(text, /Run reconcile again with the same --mapping file\./);
});

test('a failed reconcile under a refusing unlink guard names --allow-unlink (pre-public review m-i)', () => {
  const r = reconcile({ model: model([acct('101', 'Northwind')], { unlink_guard: { ok: false, reason: 'Stripe returned no customers, but 9 companies are linked' } }), current: new Map([['101', props({ rs_mrr: '999' })]]) });
  assert.match(formatReconcile(r), /sync is refusing this run \(unlink guard: Stripe returned no customers, but 9 companies are linked\)[\s\S]*--allow-unlink/);
});
