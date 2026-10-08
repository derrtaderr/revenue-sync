import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsage } from '../src/usage.mjs';

test('groups activity rows by account, keeping the domain', () => {
  const u = parseUsage('account_id,user_id,date,domain\nacct_1,u1,2026-10-01,northwind.example\nacct_1,u2,2026-10-02,\nacct_2,u9,2026-09-30,\n');
  assert.deepEqual([...u.accounts.keys()], ['acct_1', 'acct_2']);
  assert.equal(u.accounts.get('acct_1').domain, 'northwind.example');
  assert.deepEqual(u.accounts.get('acct_1').events, [{ user_id: 'u1', date: '2026-10-01' }, { user_id: 'u2', date: '2026-10-02' }]);
  assert.equal(u.accounts.get('acct_2').domain, null);
  assert.deepEqual(u.problems, []);
});

test('the domain column is optional and a timestamp keeps its date', () => {
  const u = parseUsage('account_id,user_id,date\nacct_1,u1,2026-10-01T23:10:00Z\n');
  assert.equal(u.accounts.get('acct_1').events[0].date, '2026-10-01');
});

test('missing required columns stop the read with a plain message', () => {
  assert.throws(() => parseUsage('account,user,day\nx,y,z\n'), /usage CSV needs the columns account_id, user_id, date/);
});

test('bad rows are skipped and reported by line', () => {
  const u = parseUsage('account_id,user_id,date\nacct_1,,2026-10-01\n,u1,2026-10-01\nacct_1,u1,10/01/2026\nacct_1,u1,2026-02-30\nacct_1,u1\n');
  assert.equal(u.accounts.size, 0);
  assert.deepEqual(u.problems.map((p) => p.line), [2, 3, 4, 5, 6]);
  assert.match(u.problems[2].reason, /date/);
});

test('an account that names two different domains is reported', () => {
  const u = parseUsage('account_id,user_id,date,domain\nacct_1,u1,2026-10-01,a.example\nacct_1,u2,2026-10-01,b.example\n');
  assert.equal(u.accounts.get('acct_1').domain, 'a.example');
  assert.match(u.problems[0].reason, /acct_1 already has domain a\.example/);
});

test('usage rows from any source are validated the same way as CSV lines', async () => {
  const { usageFromRecords } = await import('../src/usage.mjs');
  const r = usageFromRecords([
    { line: 1, values: { account_id: 'a1', user_id: 'u1', date: '2026-10-01', domain: 'northwind.example' } },
    { line: 2, values: { account_id: 'a1', user_id: '', date: '2026-10-02', domain: '' } },
    { line: 3, values: { account_id: 'a1', user_id: 'u2', date: 'yesterday', domain: '' } },
  ]);
  assert.equal(r.accounts.get('a1').domain, 'northwind.example');
  assert.deepEqual(r.accounts.get('a1').events, [{ user_id: 'u1', date: '2026-10-01' }]);
  assert.deepEqual(r.problems.map((p) => p.line), [2, 3]);
});
