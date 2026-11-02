// Unit (TDD): call state helpers (backend/src/services/callFlow.js) and the question plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  retriesLeft, currentStep, questionAfter, isStale, isNotReady, answerRow, recordingExtension, lastActivityMs,
  END_REASONS, NOT_READY_REASON, START_FAILED_PREFIX, MAX_CALL_ATTEMPTS, STALE_CALL_MS
} from '../../../backend/src/services/callFlow.js';
import { buildQuestionPlan } from '../../../backend/src/services/questionPlan.js';

const plan = { questions: [{ position: 0, source: 'intro' }, { position: 1, source: 'resume' }, { position: 2, source: 'hr' }] };

test('retriesLeft: not-ready and start failures are free; a completed call ends retries', () => {
  assert.equal(MAX_CALL_ATTEMPTS, 3);
  assert.equal(retriesLeft([]), 3);
  assert.equal(retriesLeft([{ status: 'failed', failure_reason: NOT_READY_REASON }, { status: 'failed', failure_reason: `${START_FAILED_PREFIX} x` }]), 3);
  assert.equal(retriesLeft([{ status: 'failed', failure_reason: 'left' }, { status: 'failed', failure_reason: 'left' }]), 1);
  assert.equal(retriesLeft(Array(5).fill({ status: 'failed', failure_reason: 'x' })), 0);
  assert.equal(retriesLeft([{ status: 'completed' }]), 0);
});

test('currentStep: first unanswered question, attempt counts candidate lines for it', () => {
  assert.deepEqual(currentStep(plan, [], []).question.position, 0);
  assert.equal(currentStep(plan, [{ position: 0 }], [{ speaker: 'candidate', position: 1 }]).attempt, 2);
  assert.equal(currentStep(plan, [{ position: 0 }, { position: 1 }, { position: 2 }], []), null);
  assert.equal(currentStep(null), null);
  assert.equal(questionAfter(plan, 2), null);
});

test('isStale: only in-progress calls idle longer than 3 minutes', () => {
  const t0 = Date.parse('2026-11-01T10:00:00Z');
  const call = { status: 'in_progress', started_at: new Date(t0).toISOString(), transcript: [{ at: new Date(t0 + 60000).toISOString() }] };
  assert.equal(STALE_CALL_MS, 180000);
  assert.equal(isStale(call, t0 + 60000 + STALE_CALL_MS), false);
  assert.equal(isStale(call, t0 + 60001 + STALE_CALL_MS), true);
  assert.equal(isStale({ ...call, status: 'completed' }, t0 + 1e9), false);
  assert.equal(lastActivityMs({ started_at: 'garbage', transcript: [{ at: 'also garbage' }] }), -Infinity, 'bad timestamps give -Infinity');
});

test('isStale treats a call with unreadable timestamps as stale immediately (fails safe)', () => {
  assert.equal(isStale({ status: 'in_progress', started_at: 'x', transcript: [] }), true);
});

test('isNotReady: only a "no" to the opening question', () => {
  assert.equal(isNotReady({ source: 'intro' }, { action: 'next', extracted: { yes: false } }), true);
  assert.equal(isNotReady({ source: 'hr' }, { action: 'next', extracted: { yes: false } }), false);
  assert.equal(isNotReady({ source: 'intro' }, { action: 'next', extracted: { text: 'no' } }), false);
});

test('answerRow: skipped answers keep every attempt, accepted ones keep the last', () => {
  const q = { position: 3, question_text: 'CTC?', source: 'hr', answer_type: 'ctc' };
  assert.equal(answerRow(q, { action: 'skip' }, ['uh', ' ', 'hmm']).answer_text, 'uh / hmm');
  const ok = answerRow(q, { action: 'next', extracted: { lpa: 9 } }, ['nine', '9 lakh']);
  assert.equal(ok.answer_text, '9 lakh');
  assert.equal(ok.attempts, 2);
  assert.equal(answerRow(q, { action: 'next', extracted: null }, []).attempts, 1);
});

test('recordingExtension: only known audio types', () => {
  assert.equal(recordingExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(recordingExtension('AUDIO/OGG'), 'ogg');
  assert.equal(recordingExtension('text/html'), null);
  assert.equal(recordingExtension(undefined), null);
});

test('BUG-06 (fixed 27 Oct): END_REASONS is a plain object, so "constructor"/"toString" look like valid reasons', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
    assert.equal(END_REASONS[key], undefined, `END_REASONS["${key}"] is ${typeof END_REASONS[key]}`);
  }
});

test('buildQuestionPlan: intro → project → problems → resume → experience check → HR by position; positions are 0..n-1', () => {
  const p = buildQuestionPlan({
    candidate: { name: '  Asha   Rao ', resume_questions: [{ question_text: 'R1?' }] },
    batch: { job_role: 'SDE', company_name: 'Acme' },
    hrQuestions: [{ question_text: 'B?', answer_type: 'ctc', position: 7 }, { question_text: 'A?', answer_type: 'duration', position: 2 }]
  });
  assert.deepEqual(p.questions.map(q => [q.position, q.source]), [[0, 'intro'], [1, 'general'], [2, 'general'], [3, 'resume'], [4, 'general'], [5, 'hr'], [6, 'hr']]);
  assert.deepEqual(p.questions.slice(3).map(q => q.question_text), ['R1?', 'Kya aapne pehle kisi company mein full-time job ki hai, ya aap fresher hain?', 'A?', 'B?']);
  assert.match(p.intro, /Namaste Asha!/);
  assert.match(p.intro, /Acme ki taraf se/);
});

test('buildQuestionPlan: a missing name or company still reads naturally', () => {
  const p = buildQuestionPlan({ candidate: { name: '' }, batch: { job_role: 'QA' } });
  assert.match(p.intro, /^Namaste! Main HireLens ki voice assistant/);
  // No HR questions: ready, project, problems (no experience check either).
  assert.deepEqual(p.questions.map(q => q.source), ['intro', 'general', 'general']);
});

test('BUG-43 (fixed 1 Nov): a candidate known to be a fresher is not given notice period or current CTC', () => {
  const p = buildQuestionPlan({
    candidate: { name: 'Fresher', resume_questions: [], is_fresher: true },
    batch: { job_role: 'Intern' },
    hrQuestions: [{ question_text: 'Aapka current notice period kitna hai?', answer_type: 'duration', position: 0 }, { question_text: 'Aapki current CTC kitni hai?', answer_type: 'ctc', position: 1 }]
  });
  assert.equal(p.questions.filter(q => q.source === 'hr').length, 0);
});
