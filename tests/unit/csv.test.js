import { test } from 'node:test';
import assert from 'node:assert/strict';
// Node 22.18+ loads TypeScript directly, so the real client parser is tested.
import { parseCsv, readCandidatesCsv } from '../../client/src/lib/csv.ts';

test('parseCsv handles quotes, escaped quotes, CRLF and blank lines', () => {
  const text = 'Name,Email\r\n"Rao, Asha","asha@example.com"\r\n\r\n"He said ""hi""",b@example.com\n';
  assert.deepEqual(parseCsv(text), [
    ['Name', 'Email'],
    ['Rao, Asha', 'asha@example.com'],
    ['He said "hi"', 'b@example.com']
  ]);
});

test('readCandidatesCsv finds common header names in any order', () => {
  const result = readCandidatesCsv('﻿Email ID;Phone;Full Name\nasha@example.com;999;Asha Rao\n');
  assert.equal(result.problem, null);
  assert.deepEqual(result.rows, [{ name: 'Asha Rao', email: 'asha@example.com' }]);
});

test('readCandidatesCsv accepts a sheet without a header row (name, email)', () => {
  const result = readCandidatesCsv('Asha Rao,asha@example.com\nVikram,vikram@example.com');
  assert.deepEqual(result.rows.map(r => r.email), ['asha@example.com', 'vikram@example.com']);
});

test('readCandidatesCsv explains a missing column', () => {
  assert.match(readCandidatesCsv('Candidate Phone,City\n999,Pune').problem, /Name.*Email/);
  assert.match(readCandidatesCsv('').problem, /empty/);
});
