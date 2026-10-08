import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyUnlinkPolicy, GUARD_SHARE, GUARD_MIN } from '../src/unlink.mjs';

const cand = (id, cleared = false) => ({ hubspot_company_id: id, hubspot_company_name: `Co ${id}`, reason: 'gone', cleared });
const linkedCurrent = (n) => new Map(Array.from({ length: n }, (_, i) => [String(100 + i), { rs_billing_status: 'active', rs_mrr: '10' }]));
const base = (over = {}) => ({
  model: { accounts: [], unlinked: [cand('100')] },
  current: linkedCurrent(20),
  snapshot: { stripe_account: 'acct_A', links: { 100: ['stripe'] } },
  provided: { mapping: true, usage: true },
  stripeAccount: { id: 'acct_A' },
  allowUnlink: false,
  customersCount: 50,
  ...over,
});

test('a candidate linked by Stripe, same account, sources given: unlinked as before', () => {
  const m = applyUnlinkPolicy(base());
  assert.equal(m.unlinked[0].held, null);
  assert.equal(m.unlink_guard.ok, true);
  assert.equal(m.unlink_guard.would_unlink, 1);
});

test('a company linked by a mapping row is never unlinked on a run without --mapping, even with --allow-unlink', () => {
  for (const allowUnlink of [false, true]) {
    const m = applyUnlinkPolicy(base({ snapshot: { stripe_account: 'acct_A', links: { 100: ['stripe', 'mapping'] } }, provided: { mapping: false, usage: true }, allowUnlink }));
    assert.match(m.unlinked[0].held, /linked by a mapping row and this run has no --mapping/);
  }
});

test('a company linked by usage is never unlinked on a run without --usage', () => {
  const m = applyUnlinkPolicy(base({ snapshot: { stripe_account: 'acct_A', links: { 100: ['usage'] } }, provided: { mapping: true, usage: false } }));
  assert.match(m.unlinked[0].held, /linked by usage and this run has no usage source \(--usage or --usage-sql\)/);
});

test('no record of how a company was linked holds it, unless --allow-unlink', () => {
  assert.match(applyUnlinkPolicy(base({ snapshot: null })).unlinked[0].held, /no record in this state folder of how it was linked/);
  assert.equal(applyUnlinkPolicy(base({ snapshot: null, allowUnlink: true })).unlinked[0].held, null);
});

test('a different Stripe account than the one recorded refuses to unlink anything, unless --allow-unlink', () => {
  const m = applyUnlinkPolicy(base({ stripeAccount: { id: 'acct_B' } }));
  assert.match(m.unlinked[0].held, /this run reads Stripe account acct_B, but this state folder was synced from acct_A/);
  assert.equal(applyUnlinkPolicy(base({ stripeAccount: { id: 'acct_B' }, allowUnlink: true })).unlinked[0].held, null);
});

test('an unreadable Stripe account refuses to unlink, unless --allow-unlink', () => {
  const m = applyUnlinkPolicy(base({ stripeAccount: { id: null, reason: 'the key may not read the Stripe account (403)' } }));
  assert.match(m.unlinked[0].held, /could not be identified \(the key may not read the Stripe account \(403\)\)/);
});

test('already-cleared candidates are never held and never count toward the guard', () => {
  const m = applyUnlinkPolicy(base({ model: { accounts: [], unlinked: [cand('100', true)] }, snapshot: null }));
  assert.equal(m.unlinked[0].held, null);
  assert.equal(m.unlink_guard.would_unlink, 0);
});

test('the guard refuses when Stripe returned no customers while companies are linked', () => {
  const m = applyUnlinkPolicy(base({ customersCount: 0 }));
  assert.equal(m.unlink_guard.ok, false);
  assert.match(m.unlink_guard.reason, /Stripe returned no customers, but 20 companies are linked/);
});

test(`the guard refuses when more than ${GUARD_MIN} companies and more than ${GUARD_SHARE * 100} percent of linked companies would unlink`, () => {
  const three = { accounts: [], unlinked: [cand('100'), cand('101'), cand('102')] };
  const links = { 100: ['stripe'], 101: ['stripe'], 102: ['stripe'] };
  const big = applyUnlinkPolicy(base({ model: three, snapshot: { stripe_account: 'acct_A', links }, current: linkedCurrent(20) }));
  assert.equal(big.unlink_guard.ok, false, '3 of 20 is 15 percent');
  assert.match(big.unlink_guard.reason, /3 of 20 linked companies \(15%\) would be unlinked in one run/);
  const small = applyUnlinkPolicy(base({ model: three, snapshot: { stripe_account: 'acct_A', links }, current: linkedCurrent(40) }));
  assert.equal(small.unlink_guard.ok, true, '3 of 40 is 7.5 percent');
  const two = applyUnlinkPolicy(base({ model: { accounts: [], unlinked: [cand('100'), cand('101')] }, snapshot: { stripe_account: 'acct_A', links }, current: linkedCurrent(3) }));
  assert.equal(two.unlink_guard.ok, true, 'two companies never trip the share rule');
});

test('--allow-unlink passes the guard and says so', () => {
  const m = applyUnlinkPolicy(base({ customersCount: 0, allowUnlink: true }));
  assert.equal(m.unlink_guard.ok, true);
  assert.match(m.unlink_guard.reason, /--allow-unlink/);
});

test('a billing source identity names its own kind: a warehouse query read after a Stripe sync holds the unlink', () => {
  const m = applyUnlinkPolicy(base({ stripeAccount: { id: 'bigquery:acme:0123456789abcdef', label: 'billing source' } }));
  assert.equal(m.unlinked[0].held, 'this run reads billing source bigquery:acme:0123456789abcdef, but this state folder was synced from acct_A (pass --allow-unlink if that is intended)');
  assert.equal(applyUnlinkPolicy(base({ stripeAccount: { id: 'bigquery:acme:0123456789abcdef', label: 'billing source' }, allowUnlink: true })).unlinked[0].held, null);
});
