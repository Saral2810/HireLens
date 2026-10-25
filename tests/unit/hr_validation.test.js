import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateBatchInput, validateQuestionInput, normalizeCandidateRows } from '../../backend/src/utils/validation.js';
import { DEFAULT_HR_QUESTIONS } from '../../backend/src/services/questionTemplates.js';

test('validateBatchInput: create needs name and job role; trims text', () => {
  const ok = validateBatchInput({ name: '  Batch 1 – 24 Oct ', job_role: 'Backend  Engineer', batch_date: '2026-10-24', company_name: '' });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.value, { name: 'Batch 1 – 24 Oct', job_role: 'Backend Engineer', batch_date: '2026-10-24', company_name: null });

  const bad = validateBatchInput({ job_role: 'x'.repeat(121), batch_date: '2026-02-30' });
  assert.equal(bad.errors.length, 3);
  assert.match(bad.errors.join(' '), /Batch name is required/);
  assert.match(bad.errors.join(' '), /at most 120/);
  assert.match(bad.errors.join(' '), /valid date/);
});

test('validateBatchInput: update checks only the fields sent', () => {
  assert.deepEqual(validateBatchInput({ company_name: 'Acme' }, { partial: true }), { value: { company_name: 'Acme' }, errors: [] });
  assert.deepEqual(validateBatchInput({}, { partial: true }).errors, ['Nothing to update.']);
});

test('validateQuestionInput: text length and answer type', () => {
  assert.deepEqual(validateQuestionInput({ question_text: 'Notice period?', answer_type: 'duration' }).errors, []);
  assert.equal(validateQuestionInput({ question_text: 'Hi' }).errors.length, 1);
  assert.match(validateQuestionInput({ question_text: 'Salary?', answer_type: 'money' }).errors[0], /Answer type/);
  assert.deepEqual(validateQuestionInput({ question_text: 'Expected CTC?' }).value, { question_text: 'Expected CTC?', answer_type: 'text' });
});

test('normalizeCandidateRows: cleans, lower-cases and reports bad rows by sheet row number', () => {
  const { valid, errors } = normalizeCandidateRows([
    { name: ' Asha  Rao ', email: 'Asha.Rao@Example.com ' },
    { name: '', email: 'x@example.com' },
    { name: 'Vikram', email: 'not-an-email' },
    { name: 'Asha again', email: 'asha.rao@example.com' }
  ]);
  assert.deepEqual(valid, [{ name: 'Asha Rao', email: 'asha.rao@example.com' }]);
  assert.deepEqual(errors.map(e => e.row), [2, 3, 4]);
  assert.match(errors[2].message, /more than once/);
  assert.equal(normalizeCandidateRows('nope').errors.length, 1);
});

test('default HR questions are valid questions', () => {
  assert.ok(DEFAULT_HR_QUESTIONS.length >= 4);
  for (const q of DEFAULT_HR_QUESTIONS) assert.deepEqual(validateQuestionInput(q).errors, []);
});
