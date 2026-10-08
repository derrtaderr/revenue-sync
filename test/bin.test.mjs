import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/revenue-sync.mjs', import.meta.url));

test('the bin runs help with real process wiring', () => {
  const r = spawnSync(process.execPath, [BIN, 'help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /revenue-sync: Stripe billing and product usage on the HubSpot company, reconciled/);
});

test('the bin passes the exit code through', () => {
  const r = spawnSync(process.execPath, [BIN, 'plan'], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /STRIPE_API_KEY is not set/);
});
