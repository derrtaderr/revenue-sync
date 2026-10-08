import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openJournal } from '../src/journal.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'rs-journal-'));
const batches = [{ n: 1, inputs: [{ id: '101', properties: { rs_mrr: '400' } }] }, { n: 2, inputs: [{ id: '102', properties: { rs_mrr: '10' } }] }];

test('no journal means nothing to resume', () => {
  assert.equal(openJournal(tmp()).unfinished(), null);
});

test('a run that crashed after batch 1 resumes with batch 1 done and batch 2 pending', () => {
  const dir = tmp();
  const j = openJournal(dir);
  j.start('run-1', batches);
  j.done('run-1', 1);
  const u = openJournal(dir).unfinished();
  assert.equal(u.run, 'run-1');
  assert.deepEqual(u.batches, batches);
  assert.deepEqual([...u.done], [1]);
  assert.equal(statSync(join(dir, 'journal.jsonl')).mode & 0o777, 0o600);
});

test('a completed run leaves nothing to resume', () => {
  const dir = tmp();
  const j = openJournal(dir);
  j.start('run-1', batches);
  j.done('run-1', 1);
  j.done('run-1', 2);
  j.complete('run-1');
  assert.equal(openJournal(dir).unfinished(), null);
});

test('a new run starts a fresh journal', () => {
  const dir = tmp();
  const j = openJournal(dir);
  j.start('run-1', batches);
  j.complete('run-1');
  j.start('run-2', batches.slice(0, 1));
  const lines = readFileSync(join(dir, 'journal.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).run, 'run-2');
});

test('a torn last line (the crash happened mid-write) is ignored, not fatal', () => {
  const dir = tmp();
  const j = openJournal(dir);
  j.start('run-1', batches);
  appendFileSync(join(dir, 'journal.jsonl'), '{"type":"done","run":"run-1","ba');
  const u = openJournal(dir).unfinished();
  assert.deepEqual([...u.done], []);
});
