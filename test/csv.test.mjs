import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv } from '../src/csv.mjs';

test('reads a header and rows into objects with their line numbers', () => {
  const r = parseCsv('a,b\n1,2\n3,4\n');
  assert.deepEqual(r.header, ['a', 'b']);
  assert.deepEqual(r.rows, [{ line: 2, values: { a: '1', b: '2' } }, { line: 3, values: { a: '3', b: '4' } }]);
});

test('handles quotes, embedded commas, escaped quotes, CRLF and a byte order mark', () => {
  const r = parseCsv('﻿name,note\r\n"Acme, Inc","said ""hi"""\r\n');
  assert.deepEqual(r.header, ['name', 'note']);
  assert.deepEqual(r.rows[0].values, { name: 'Acme, Inc', note: 'said "hi"' });
});

test('header names are trimmed and lower-cased; blank lines are skipped', () => {
  const r = parseCsv(' Account_ID , User_Id\n\nx,y\n');
  assert.deepEqual(r.header, ['account_id', 'user_id']);
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].line, 3);
});

test('a row with the wrong number of fields is reported, not guessed', () => {
  const r = parseCsv('a,b\n1\n1,2,3\n');
  assert.equal(r.rows.length, 0);
  assert.deepEqual(r.problems, [{ line: 2, reason: 'has 1 fields, the header has 2' }, { line: 3, reason: 'has 3 fields, the header has 2' }]);
});

test('an empty file has no header', () => {
  assert.deepEqual(parseCsv(''), { header: [], rows: [], problems: [] });
});
