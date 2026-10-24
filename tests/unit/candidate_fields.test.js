import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateLead, candidateColumns, parseNoticePeriodDays } from '../../backend/src/utils/validation.js';

const base = () => ({ tenant_id: 't1', phone: '9876543210', source: 'hr-upload' });

test('lifts candidate fields from CSV-style raw_data headers', () => {
  const lead = {
    ...base(),
    raw_data: {
      'Job Role': 'Backend Engineer',
      'Total Experience': '4.5 years',
      'Current CTC': '12,00,000',
      'Expected CTC': 1800000,
      'Notice Period': '2 months',
      'Key Skills': 'Node, Postgres',
      'Resume Link': 'https://example.com/cv.pdf',
      'Interview Date': '2026-11-02T10:30:00+05:30'
    }
  };
  const res = validateLead(lead);
  assert.equal(res.isValid, true, res.errors.join(', '));
  assert.equal(lead.job_role, 'Backend Engineer');
  assert.equal(lead.experience_years, 4.5);
  assert.equal(lead.current_ctc, 1200000);
  assert.equal(lead.expected_ctc, 1800000);
  assert.equal(lead.notice_period_days, 60);
  assert.equal(lead.skills, 'Node, Postgres');
  assert.equal(lead.resume_url, 'https://example.com/cv.pdf');
  assert.equal(lead.interview_slot, '2026-11-02T05:00:00.000Z');
});

test('top-level fields win over raw_data', () => {
  const lead = { ...base(), job_role: 'QA Lead', raw_data: { role: 'Intern' } };
  validateLead(lead);
  assert.equal(lead.job_role, 'QA Lead');
});

test('rejects bad candidate values', () => {
  const lead = {
    ...base(),
    experience_years: 'lots',
    notice_period: 'soon',
    resume_url: 'cv.pdf',
    interview_slot: 'next tuesday-ish',
    screening_status: 'hired'
  };
  const res = validateLead(lead);
  assert.equal(res.isValid, false);
  assert.equal(res.errors.length, 5);
});

test('candidates without HR fields still validate', () => {
  const res = validateLead(base());
  assert.equal(res.isValid, true);
});

test('candidateColumns always sets screening_status', () => {
  const cols = candidateColumns({ job_role: 'Designer' });
  assert.equal(cols.job_role, 'Designer');
  assert.equal(cols.current_ctc, null);
  assert.equal(cols.screening_status, 'pending');
});

test('parseNoticePeriodDays', () => {
  assert.equal(parseNoticePeriodDays('Immediate'), 0);
  assert.equal(parseNoticePeriodDays('30'), 30);
  assert.equal(parseNoticePeriodDays('1 week'), 7);
  assert.equal(parseNoticePeriodDays(90), 90);
  assert.equal(parseNoticePeriodDays('soon'), null);
});
