// Unit (TDD): HR input validation and spoken-answer parsing (backend/src/utils/validation.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateBatchInput, validateQuestionInput, normalizeCandidateRows, parseNoticePeriodDays, parseNumber, MAX_CANDIDATES_PER_BATCH
} from '../../../backend/src/utils/validation.js';

test('validateBatchInput: trims and collapses whitespace, enforces limits', () => {
  const { value, errors } = validateBatchInput({ name: '  Backend   hiring ', job_role: 'SDE', company_name: '  ', job_description: 'x'.repeat(4000) });
  assert.deepEqual(errors, []);
  assert.equal(value.name, 'Backend hiring');
  assert.equal(value.company_name, null);
  assert.equal(validateBatchInput({ name: 'a', job_role: 'b', job_description: 'x'.repeat(4001) }).errors.length, 1);
});

test('validateBatchInput: non-string values are rejected, not stringified', () => {
  assert.ok(validateBatchInput({ name: { $ne: '' }, job_role: ['x'] }).errors.length >= 2);
  assert.ok(validateBatchInput({ name: 'A', job_role: 'B', batch_date: 20261101 }).errors.length === 1);
});

test('validateBatchInput: partial update with nothing valid is an error; unknown keys are dropped', () => {
  assert.deepEqual(validateBatchInput({}, { partial: true }).errors, ['Nothing to update.']);
  const { value } = validateBatchInput({ name: 'A', status: 'live', created_by: 'x' }, { partial: true });
  assert.deepEqual(Object.keys(value), ['name']);
});

test('validateBatchInput: impossible dates are refused', () => {
  for (const d of ['2026-02-30', '2026-13-01', '26-11-01', '2026-11-1']) assert.equal(validateBatchInput({ name: 'a', job_role: 'b', batch_date: d }).errors.length, 1, d);
  assert.equal(validateBatchInput({ name: 'a', job_role: 'b', batch_date: '2028-02-29' }).errors.length, 0);
});

test('validateQuestionInput: 3–300 chars, known answer types, default text', () => {
  assert.equal(validateQuestionInput({ question_text: 'Notice period?' }).value.answer_type, 'text');
  assert.equal(validateQuestionInput({ question_text: 'ab' }).errors.length, 1);
  assert.equal(validateQuestionInput({ question_text: 'x'.repeat(301) }).errors.length, 1);
  assert.equal(validateQuestionInput({ question_text: 'Valid?', answer_type: 'money' }).errors.length, 1);
  assert.equal(validateQuestionInput({ question_text: 'Valid?', answer_type: '__proto__' }).errors.length, 1);
});

test('normalizeCandidateRows: lower-cases emails, numbers rows from 1, reports repeats', () => {
  const r = normalizeCandidateRows([{ name: 'A', email: 'A@X.CO' }, { name: 'B', email: 'a@x.co' }, { name: '', email: 'c@x.co' }]);
  assert.deepEqual(r.valid, [{ name: 'A', email: 'a@x.co' }]);
  assert.deepEqual(r.errors.map(e => e.row), [2, 3]);
  assert.deepEqual(normalizeCandidateRows('nope').errors[0].row, 0);
  assert.equal(MAX_CANDIDATES_PER_BATCH, 100);
});

test('BUG-38: email check accepts addresses no mail server would (a@b..co, a@-x.co, a@x.c)', { todo: 'BUG-38 permissive email regex' }, () => {
  const r = normalizeCandidateRows([{ name: 'A', email: 'a@b..co' }, { name: 'B', email: 'a@-x.co' }, { name: 'C', email: 'a@x.c' }]);
  assert.equal(r.valid.length, 0, `accepted: ${r.valid.map(v => v.email).join(', ')}`);
});

test('parseNoticePeriodDays: common spoken forms', () => {
  assert.equal(parseNoticePeriodDays('Immediate'), 0);
  assert.equal(parseNoticePeriodDays('2 months'), 60);
  assert.equal(parseNoticePeriodDays('1.5 months'), 45);
  assert.equal(parseNoticePeriodDays('3 weeks'), 21);
  assert.equal(parseNoticePeriodDays('30'), 30);
  assert.equal(parseNoticePeriodDays(45), 45);
  assert.equal(parseNoticePeriodDays(-5), null);
  assert.equal(parseNoticePeriodDays('kuch pata nahi'), null);
});

test('BUG-19: "not serving notice, my notice is 60 days" is read as 0 days (the word "serving" wins)', { todo: 'BUG-19 notice parser keyword match' }, () => {
  assert.equal(parseNoticePeriodDays('I am not serving notice, my notice period is 60 days'), 60);
});

test('BUG-19: number words ("two months", "do mahine", "teen hafte") are not understood by the fallback parser', { todo: 'BUG-19 notice parser has no number words / Hindi units' }, () => {
  assert.equal(parseNoticePeriodDays('two months'), 60);
  assert.equal(parseNoticePeriodDays('2 mahine'), 60);
});

test('parseNumber: Indian digit grouping and units text', () => {
  assert.equal(parseNumber('12,00,000'), 1200000);
  assert.equal(parseNumber('4.5 years'), 4.5);
  assert.equal(parseNumber('-1'), null);
  assert.equal(parseNumber('abc'), null);
});

test('BUG-19: a leading currency sign ("₹12,00,000", "Rs. 9 lakh") makes parseNumber give up', { todo: 'BUG-19 parseNumber ignores currency prefixes' }, () => {
  assert.equal(parseNumber('₹12,00,000'), 1200000);
  assert.equal(parseNumber('Rs. 9'), 9);
});
