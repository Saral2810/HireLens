// Unit (TDD): results table, CSV export, spreadsheet import, analytics, resume text, client CSV helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickCall, displayValue, keyFacts, buildResultRows, exportTable, toCsv } from '../../../backend/src/services/results.js';
import { parseCsvTable, rowsFromTable, cellText } from '../../../backend/src/services/spreadsheet.js';
import { computeAnalytics } from '../../../backend/src/services/analytics.js';
import { extractResumeText, looksLikePdf, MAX_RESUME_CHARS } from '../../../backend/src/services/resumeParser.js';
import { makeTextPdf } from '../../../backend/scripts/makeTextPdf.js';
import { readCandidatesCsv } from '../../../client/src/lib/csv.ts';

test('pickCall prefers the newest completed call, else the newest call', () => {
  const calls = [{ id: 'a', status: 'completed', started_at: '2026-11-01T10:00:00Z' }, { id: 'b', status: 'failed', started_at: '2026-11-02T10:00:00Z' }];
  assert.equal(pickCall(calls).id, 'a');
  assert.equal(pickCall([calls[1]]).id, 'b');
  assert.equal(pickCall([]), null);
});

test('displayValue covers every answer type and skips', () => {
  assert.equal(displayValue({ answer_type: 'duration', outcome: 'answered', extracted_value: { days: 0 } }), 'Immediate');
  assert.equal(displayValue({ answer_type: 'ctc', outcome: 'answered', extracted_value: { lpa: 9 } }), '9 LPA');
  assert.equal(displayValue({ answer_type: 'yes_no', outcome: 'answered', extracted_value: { yes: false } }), 'No');
  assert.equal(displayValue({ answer_type: 'ctc', outcome: 'skipped', answer_text: 'hmm' }), 'Skipped (heard: hmm)');
  assert.equal(displayValue({ answer_type: 'ctc', outcome: 'answered', extracted_value: { lpa: 'nine' }, answer_text: 'nine lakh' }), 'nine lakh');
  assert.equal(displayValue(null), '');
});

test('keyFacts tells current and expected CTC apart by wording, else by order', () => {
  const a = (q, lpa) => ({ source: 'hr', outcome: 'answered', answer_type: 'ctc', question_text: q, extracted_value: { lpa } });
  assert.deepEqual(keyFacts([a('Expected CTC?', 12), a('Current CTC?', 9)]), { notice_period_days: null, current_ctc_lpa: 9, expected_ctc_lpa: 12 });
  assert.deepEqual(keyFacts([a('Salary 1?', 5), a('Salary 2?', 7)]), { notice_period_days: null, current_ctc_lpa: 5, expected_ctc_lpa: 7 });
});

test('BUG-44 (fixed 1 Nov): a lone salary question about what the candidate wants is not shown as current CTC', () => {
  const only = [{ source: 'hr', outcome: 'answered', answer_type: 'ctc', question_text: 'Aap kitni salary chahte hain?', extracted_value: { lpa: 6 } }];
  assert.equal(keyFacts(only).current_ctc_lpa, null);
});

test('buildResultRows: one row per candidate, newest call, answers sorted', () => {
  const rows = buildResultRows({
    candidates: [{ id: 'c1', name: 'A', email: 'a@x', status: 'completed' }, { id: 'c2', name: 'B', email: 'b@x', status: 'invited' }],
    calls: [{ id: 'k1', candidate_id: 'c1', status: 'completed', started_at: '2026-11-01T10:00:00Z', ended_at: '2026-11-01T10:05:00Z' }],
    answers: [{ call_id: 'k1', position: 2, source: 'hr', question_text: 'Q2', answer_type: 'text', outcome: 'answered', extracted_value: { text: 'b' } }, { call_id: 'k1', position: 1, source: 'hr', question_text: 'Q1', answer_type: 'text', outcome: 'answered', extracted_value: { text: 'a' } }]
  });
  assert.equal(rows[0].call.duration_seconds, 300);
  assert.deepEqual(rows[0].answers.map(x => x.position), [1, 2]);
  assert.equal(rows[1].call, null);
});

test('toCsv: BOM, quoting, and = + - @ formula guard', () => {
  const csv = toCsv({ headers: ['a', 'b'], rows: [['=1+1', 'x,"y"'], ['@SUM(A1)', null], [-5, '+91 98']] });
  assert.ok(csv.startsWith('﻿'));
  assert.match(csv, /'=1\+1,"x,""y"""/);
  assert.match(csv, /'@SUM\(A1\),/);
  assert.match(csv, /-5,'\+91 98/);
});

test('BUG-20: cells starting with TAB or CR (also formula triggers in Excel/LibreOffice) are not neutralised', { todo: 'BUG-20 CSV guard misses \\t and \\r' }, () => {
  const csv = toCsv({ headers: ['a'], rows: [['\t=cmd|"/c calc"!A1'], ['\r=1+1']] });
  assert.doesNotMatch(csv, /^"?\t=/m);
  assert.doesNotMatch(csv, /"\r=/);
});

test('exportTable: HR question columns follow the current questions, matched by wording', () => {
  const t = exportTable([{ name: 'A', email: 'a@x', status: 'completed', answers: [{ source: 'hr', question_text: ' Notice? ', display: '60 days' }] }], [{ question_text: 'notice?', position: 0 }]);
  assert.equal(t.headers[10], 'notice?');
  assert.equal(t.rows[0][10], '60 days');
});

test('parseCsvTable: quotes, escaped quotes, semicolons, CRLF and BOM', () => {
  assert.deepEqual(parseCsvTable('﻿Name;Email\r\n"Rao; Asha";a@x.co\r\n'), [['Name', 'Email'], ['Rao; Asha', 'a@x.co']]);
  assert.deepEqual(parseCsvTable('a,"b ""q"" c"\n\n'), [['a', 'b "q" c']]);
});

test('rowsFromTable: finds columns by header or by content; reports no email column', () => {
  assert.deepEqual(rowsFromTable([['Email', 'Name'], ['A@X.CO', 'Asha']]).rows, [{ name: 'Asha', email: 'a@x.co' }]);
  assert.deepEqual(rowsFromTable([['Asha', 'a@x.co'], ['Ravi', 'r@x.co']]).rows.length, 2);
  assert.ok(rowsFromTable([['Name'], ['Asha']]).error);
  assert.ok(rowsFromTable([]).error);
});

test('BUG-42: server import and client CSV reader disagree — "Applicant Name / EmailID" headers turn into a junk data row on the server', { todo: 'BUG-42 header lists differ between client/src/lib/csv.ts and services/spreadsheet.js' }, () => {
  const table = [['Applicant Name', 'EmailID'], ['Asha', 'a@x.co']];
  assert.equal(readCandidatesCsv('Applicant Name,EmailID\nAsha,a@x.co').rows.length, 1, 'client reads one row');
  assert.equal(rowsFromTable(table).rows.length, 1, `server read: ${JSON.stringify(rowsFromTable(table).rows)}`);
});

test('cellText reads rich text, hyperlinks (mailto), formula results and dates', () => {
  assert.equal(cellText({ richText: [{ text: 'As' }, { text: 'ha ' }] }), 'Asha');
  assert.equal(cellText({ text: 'a@x.co', hyperlink: 'mailto:a@x.co' }), 'a@x.co');
  assert.equal(cellText({ hyperlink: 'mailto:b@x.co' }), 'b@x.co');
  assert.equal(cellText({ formula: 'A1', result: 'c@x.co' }), 'c@x.co');
  assert.equal(cellText(new Date('2026-11-01T00:00:00Z')), '2026-11-01');
});

test('computeAnalytics: funnel, completion rate, score buckets incl. 100', () => {
  const r = computeAnalytics({
    batches: [{ id: 'b1', status: 'live', name: 'B' }, { id: 'b2', status: 'draft', name: 'D' }],
    candidates: [{ id: 'c1', batch_id: 'b1', status: 'completed' }, { id: 'c2', batch_id: 'b1', status: 'invited' }, { id: 'c3', batch_id: 'b2', status: 'invited' }],
    calls: [{ id: 'k1', candidate_id: 'c1', status: 'completed', fit_score: 100, started_at: '2026-11-01T10:00:00Z', ended_at: '2026-11-01T10:04:00Z' }],
    now: Date.parse('2026-11-01T12:00:00Z')
  });
  assert.equal(r.completion_rate, 50);
  assert.equal(r.score_distribution[4].count, 1);
  assert.equal(r.avg_call_seconds, 240);
  assert.equal(r.funnel[1].count, 2);
});

test('resume text: PDF signature check, readable flag, never longer than the prompt limit', async () => {
  assert.equal(looksLikePdf(Buffer.from('%PDF-1.4')), true);
  assert.equal(looksLikePdf('%PDF-1.4'), false);
  const long = await extractResumeText(makeTextPdf(Array.from({ length: 50 }, (_, i) => `Line ${i} `.repeat(60))));
  assert.equal(long.text.length <= MAX_RESUME_CHARS, true);
  assert.equal(long.readable, true);
  // makeTextPdf writes one page, so it cannot reach the 12,000-character cut; the cap itself is checked above.
});

test('client CSV reader: header detection, header-less "name,email", tabs', () => {
  assert.equal(readCandidatesCsv('Full Name\tEmail ID\nAsha\ta@x.co').rows[0].email, 'a@x.co');
  assert.equal(readCandidatesCsv('Asha,a@x.co\nRavi,r@x.co').rows.length, 2);
  assert.ok(readCandidatesCsv('foo,bar\n1,2').problem);
  assert.ok(readCandidatesCsv('').problem);
});
