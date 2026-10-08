import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJson, readJson, ensureDir, readSnapshot } from '../src/store.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rs-store-'));

test('writes JSON atomically with private permissions and reads it back', () => {
  const dir = join(tmp(), 'state');
  ensureDir(dir);
  writeJson(join(dir, 'model.json'), { a: 1 });
  assert.deepEqual(readJson(join(dir, 'model.json')), { a: 1 });
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, 'model.json')).mode & 0o777, 0o600);
  assert.deepEqual(readdirSync(dir), ['model.json'], 'no temp file left behind');
});

test('a missing file reads as null; a corrupt one is a plain error naming the file', () => {
  const dir = tmp();
  assert.equal(readJson(join(dir, 'nope.json')), null);
  writeFileSync(join(dir, 'bad.json'), '{oops');
  assert.throws(() => readJson(join(dir, 'bad.json')), /bad\.json is not valid JSON/);
});

test('an existing folder keeps its permissions; only folders the tool creates are 0700 (I3)', async () => {
  const { mkdirSync, chmodSync } = await import('node:fs');
  const dir = join(tmp(), 'shared');
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  ensureDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o755);
});

test('readSnapshot returns null when there is none, the object when it has the shape sync writes, and a plain error otherwise (pre-public review m-f)', () => {
  const dir = tmp();
  const file = join(dir, 'synced.json');
  assert.equal(readSnapshot(file), null);
  const good = { schema: 'revenue-sync.synced', version: 1, synced_at: '2026-10-07T09:00:00.000Z', stripe_account: null, values: { 1: { rs_mrr: '10' } }, links: { 1: ['mapping', 'stripe'] }, names: { 1: 'Globex' } };
  writeFileSync(file, JSON.stringify(good));
  assert.deepEqual(readSnapshot(file), good);
  for (const bad of ['[]', '{"links":{"1":5}}', '{"values":{"1":[]}}', '{"stripe_account":7}']) {
    writeFileSync(file, bad);
    assert.throws(() => readSnapshot(file), /synced\.json .*not in the shape[\s\S]*Move it aside/, bad);
  }
});

test('readSnapshot refuses another schema or version, and a synced_at that is not a string, with a plain message (m5)', () => {
  const file = join(tmp(), 'synced.json');
  for (const [bad, msg] of [
    ['{"schema":"other","version":1}', /written by another tool or version \(schema "other", version 1\)/],
    ['{"schema":"revenue-sync.synced","version":99}', /written by another tool or version \(schema "revenue-sync\.synced", version 99\)/],
    ['{"synced_at":5}', /not in the shape sync writes/],
  ]) {
    writeFileSync(file, bad);
    assert.throws(() => readSnapshot(file), msg, bad);
    assert.throws(() => readSnapshot(file), /Move it aside/, bad);
  }
});
