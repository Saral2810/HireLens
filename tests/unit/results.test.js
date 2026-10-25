import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCall, displayValue, keyFacts, buildResultRows, exportTable, toCsv } from '../../backend/src/services/results.js';

const hr = (question_text, answer_type, extracted_value, outcome = 'answered') => ({ source: 'hr', question_text, answer_type, extracted_value, outcome });

test('the newest completed call represents the candidate, else the newest call', () => {
  const calls = [
    { id: 'a', status: 'completed', started_at: '2026-11-01T10:00:00Z' },
    { id: 'b', status: 'failed', started_at: '2026-11-02T10:00:00Z' }
  ];
  assert.equal(pickCall(calls).id, 'a');
  assert.equal(pickCall([calls[1]]).id, 'b');
  assert.equal(pickCall([]), null);
});

test('answers display the way HR reads them', () => {
  assert.equal(displayValue({ answer_type: 'duration', outcome: 'answered', extracted_value: { days: 60 } }), '60 days');
  assert.equal(displayValue({ answer_type: 'duration', outcome: 'answered', extracted_value: { days: 0 } }), 'Immediate');
  assert.equal(displayValue({ answer_type: 'ctc', outcome: 'answered', extracted_value: { lpa: 12 } }), '12 LPA');
  assert.equal(displayValue({ answer_type: 'yes_no', outcome: 'answered', extracted_value: { yes: false } }), 'No');
  assert.equal(displayValue({ answer_type: 'number', outcome: 'answered', extracted_value: { value: 2.5 } }), '2.5');
  // A type whose value could not be extracted falls back to what was said.
  assert.equal(displayValue({ answer_type: 'ctc', outcome: 'answered', extracted_value: { text: 'around ten' }, answer_text: 'around ten' }), 'around ten');
  assert.equal(displayValue({ answer_type: 'text', outcome: 'skipped', answer_text: null }), 'Skipped');
});

test('current and expected CTC are told apart by wording, then by order', () => {
  const worded = keyFacts([
    hr('Aapki expected CTC kitni hai?', 'ctc', { lpa: 12 }),
    hr('Aapki current CTC kitni hai?', 'ctc', { lpa: 9 }),
    hr('Notice period?', 'duration', { days: 30 })
  ]);
  assert.deepEqual(worded, { notice_period_days: 30, current_ctc_lpa: 9, expected_ctc_lpa: 12 });
  const plain = keyFacts([hr('Salary abhi?', 'ctc', { lpa: 5 }), hr('Salary chahiye?', 'ctc', { lpa: 7 })]);
  assert.deepEqual([plain.current_ctc_lpa, plain.expected_ctc_lpa], [5, 7]);
  // A fresher asked only for expected CTC has no current CTC.
  const fresher = keyFacts([hr('Aapki expected CTC kitni hai?', 'ctc', { lpa: 4 })]);
  assert.deepEqual([fresher.current_ctc_lpa, fresher.expected_ctc_lpa], [null, 4]);
  // Skipped answers do not count.
  assert.equal(keyFacts([hr('Notice?', 'duration', null, 'skipped')]).notice_period_days, null);
});

test('rows join candidates, their call and its answers in order', () => {
  const rows = buildResultRows({
    candidates: [{ id: 'c1', name: 'Asha', email: 'a@x.test', status: 'completed' }, { id: 'c2', name: 'Ravi', email: 'r@x.test', status: 'invited' }],
    calls: [{ id: 'k1', candidate_id: 'c1', status: 'completed', started_at: '2026-11-01T10:00:00Z', ended_at: '2026-11-01T10:05:30Z', summary: 'Good.', fit_score: 72, recording_path: 'b/c1.webm' }],
    answers: [
      { call_id: 'k1', position: 2, ...hr('Aapka notice period?', 'duration', { days: 60 }) },
      { call_id: 'k1', position: 0, source: 'intro', question_text: 'Ready?', answer_type: 'yes_no', extracted_value: { yes: true }, outcome: 'answered' }
    ]
  });
  assert.deepEqual(rows[0].answers.map(a => a.position), [0, 2]);
  assert.deepEqual([rows[0].call.duration_seconds, rows[0].call.has_recording, rows[0].notice_period_days], [330, true, 60]);
  assert.deepEqual([rows[1].call, rows[1].attempts, rows[1].answers.length], [null, 0, 0]);
});

test('export has a column per HR question and safe CSV', () => {
  const rows = buildResultRows({
    candidates: [{ id: 'c1', name: '=HYPERLINK("x")', email: 'a@x.test', status: 'completed' }],
    calls: [{ id: 'k1', candidate_id: 'c1', status: 'completed', started_at: '2026-11-01T10:00:00Z', ended_at: '2026-11-01T10:06:00Z', summary: 'Said "yes", then, more', fit_score: 50 }],
    answers: [{ call_id: 'k1', position: 1, ...hr('Aapka notice period?', 'duration', { days: 60 }) }]
  });
  const table = exportTable(rows, [{ question_text: 'Aapka notice period?', position: 0 }, { question_text: 'Not asked yet?', position: 1 }]);
  assert.ok(table.headers.includes('Aapka notice period?') && table.headers.includes('Not asked yet?'));
  const row = table.rows[0];
  assert.equal(row[table.headers.indexOf('Aapka notice period?')], '60 days');
  assert.equal(row[table.headers.indexOf('Not asked yet?')], null);
  assert.equal(row[table.headers.indexOf('Call length (min)')], 6);

  const csv = toCsv(table);
  assert.ok(csv.startsWith('﻿Name,Email'));
  assert.match(csv, /"'=HYPERLINK\(""x""\)"/);
  assert.match(csv, /"Said ""yes"", then, more"/);
});
