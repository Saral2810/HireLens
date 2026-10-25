import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  currentStep, questionAfter, isStale, isNotReady, answerRow, line, recordingExtension, STALE_CALL_MS
} from '../../backend/src/services/callFlow.js';
import { decideTurn, summarizeCall } from '../../backend/src/services/brain.js';
import { speakCached, clearAudioCache } from '../../backend/src/services/gnaniSpeech.js';
import { buildQuestionPlan } from '../../backend/src/services/questionPlan.js';

const plan = buildQuestionPlan({
  candidate: { name: 'Asha Rao', resume_questions: [{ question_text: 'Aapke chatbot project mein aapne kya banaya?', answer_type: 'text' }] },
  batch: { job_role: 'Backend Engineer' },
  hrQuestions: [{ question_text: 'Aapka notice period kitna hai?', answer_type: 'duration', position: 0 }]
});

function fakeLlm(content) {
  return async () => ({ json: async () => ({ choices: [{ message: { content } }] }) });
}

test('the call starts at the first question and counts attempts from the transcript', () => {
  assert.deepEqual(currentStep(plan, [], []), { question: plan.questions[0], attempt: 1 });
  const transcript = [line('agent', plan.intro), line('candidate', 'hmm', 0)];
  assert.equal(currentStep(plan, [], transcript).attempt, 2);
});

test('saved answers move the call forward, and the end of the plan returns null', () => {
  const answers = [{ position: 0 }, { position: 1 }];
  assert.equal(currentStep(plan, answers, []).question.source, 'hr');
  assert.equal(currentStep(plan, [...answers, { position: 2 }], []), null);
  assert.equal(questionAfter(plan, 1).position, 2);
  assert.equal(questionAfter(plan, 2), null);
});

test('a call goes stale only after 3 minutes without a saved line', () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  const started = new Date(now - STALE_CALL_MS - 1000).toISOString();
  assert.equal(isStale({ status: 'in_progress', started_at: started, transcript: [] }, now), true);
  const recent = { status: 'in_progress', started_at: started, transcript: [line('candidate', 'haan', 0, new Date(now - 10000))] };
  assert.equal(isStale(recent, now), false);
  assert.equal(isStale({ status: 'completed', started_at: started, transcript: [] }, now), false);
});

test('"no" to the opening question means not ready; other answers do not', () => {
  const intro = plan.questions[0];
  assert.equal(isNotReady(intro, { action: 'next', extracted: { yes: false } }), true);
  assert.equal(isNotReady(intro, { action: 'next', extracted: { yes: true } }), false);
  assert.equal(isNotReady(intro, { action: 'skip', extracted: null }), false);
  assert.equal(isNotReady(plan.questions[2], { action: 'next', extracted: { yes: false } }), false);
});

test('answer rows keep the accepted answer, or every attempt when skipped', () => {
  const q = plan.questions[2];
  const ok = answerRow(q, { action: 'next', extracted: { days: 60 } }, ['kya?', 'do mahine']);
  assert.deepEqual(
    [ok.answer_text, ok.extracted_value, ok.outcome, ok.attempts, ok.source, ok.answer_type],
    ['do mahine', { days: 60 }, 'answered', 2, 'hr', 'duration']
  );
  const skipped = answerRow(q, { action: 'skip', extracted: null }, ['', 'umm']);
  assert.deepEqual([skipped.answer_text, skipped.extracted_value, skipped.outcome, skipped.attempts], ['umm', null, 'skipped', 2]);
});

test('recording types map to storage extensions', () => {
  assert.equal(recordingExtension('audio/webm;codecs=opus'), 'webm');
  assert.equal(recordingExtension('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(recordingExtension('application/pdf'), null);
});

test('number answers extract a value, with a digit fallback', async () => {
  const d1 = await decideTurn({ question: 'Kitne saal ka experience hai?', answerType: 'number', transcript: 'dhai saal' }, { llm: fakeLlm('{"action":"next","extracted":{"value":2.5}}') });
  assert.deepEqual(d1.extracted, { value: 2.5 });
  const d2 = await decideTurn({ question: 'Kitne saal ka experience hai?', answerType: 'number', transcript: '4 saal' }, { llm: fakeLlm('{"action":"next","extracted":{"text":"4 years"}}') });
  assert.deepEqual(d2.extracted, { value: 4 });
});

test('call summary is clamped, and missing when the brain is down', async () => {
  const answers = [
    { question_text: 'Ready?', source: 'intro', answer_text: 'haan', extracted_value: { yes: true }, outcome: 'answered' },
    { question_text: 'Notice?', source: 'hr', answer_text: 'do mahine', extracted_value: { days: 60 }, outcome: 'answered' }
  ];
  const s = await summarizeCall({ batch: { job_role: 'Engineer' }, answers }, { llm: fakeLlm('{"summary":"Good fit.","fit_score":140}') });
  assert.deepEqual([s.summary, s.fit_score, s.source], ['Good fit.', 100, 'llm']);
  const none = await summarizeCall({ batch: { job_role: 'Engineer' }, answers }, { llm: async () => null });
  assert.deepEqual([none.summary, none.fit_score, none.source], [null, null, 'none']);
});

test('repeated lines are spoken once and then served from the cache', async () => {
  clearAudioCache();
  let calls = 0;
  const speakFn = async () => { calls += 1; return { audio: Buffer.from('mp3'), contentType: 'audio/mpeg', ms: 400 }; };
  const first = await speakCached('Aapka notice period kitna hai?', {}, { speakFn });
  const second = await speakCached('Aapka notice period kitna hai?', {}, { speakFn });
  await speakCached('Aapki current CTC kitni hai?', {}, { speakFn });
  assert.deepEqual([first.cached, second.cached, second.ms, calls], [false, true, 0, 2]);
});
