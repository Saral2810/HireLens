import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateSchedule, MAX_SCHEDULE_DAYS } from '../../backend/src/services/campaignScheduler.js';
import { soundsLikeFresher, saysNoFullTimeJob, decideTurn } from '../../backend/src/services/brain.js';
import { buildQuestionPlan, skipForFresher, RESUME_QUESTIONS_IN_CALL } from '../../backend/src/services/questionPlan.js';
import { phrases, PHRASES } from '../../backend/src/services/callLanguage.js';
import { unverifiedGoogleEmail } from '../../backend/src/routes/auth.js';
import { exportTable } from '../../backend/src/services/results.js';

const NOW = new Date('2026-11-02T10:00:00Z');
const at = (h) => new Date(NOW.getTime() + h * 3600 * 1000).toISOString();

// ── Scheduling ──

test('validateSchedule: a draft needs a future start within the limit; close must come after it', () => {
  const draft = { status: 'draft' };
  assert.deepEqual(validateSchedule({ start_at: at(2) }, draft, NOW), { value: { scheduled_at: at(2), closes_at: null }, errors: [] });
  assert.deepEqual(validateSchedule({ start_at: at(2), close_at: at(30) }, draft, NOW).value, { scheduled_at: at(2), closes_at: at(30) });
  assert.equal(validateSchedule({ start_at: at(-1) }, draft, NOW).errors.length, 1);
  assert.equal(validateSchedule({ start_at: at(24 * (MAX_SCHEDULE_DAYS + 1)) }, draft, NOW).errors.length, 1);
  assert.equal(validateSchedule({ start_at: at(5), close_at: at(5) }, draft, NOW).errors.length, 1);
  assert.equal(validateSchedule({}, draft, NOW).errors.length, 1);
  assert.equal(validateSchedule({ start_at: { $gt: '' } }, draft, NOW).errors.length, 1, 'objects are not dates');
  assert.equal(validateSchedule({ start_at: '2026-13-45T99:00' }, draft, NOW).errors.length, 1);
});

test('validateSchedule: live campaigns only take a close time; closed ones nothing', () => {
  assert.deepEqual(validateSchedule({ close_at: at(3) }, { status: 'live' }, NOW), { value: { closes_at: at(3) }, errors: [] });
  assert.equal(validateSchedule({ start_at: at(3) }, { status: 'live' }, NOW).errors.length, 1);
  assert.equal(validateSchedule({ close_at: at(-3) }, { status: 'live' }, NOW).errors.length, 1);
  assert.deepEqual(validateSchedule({}, { status: 'live' }, NOW).value, { closes_at: null }, 'no close time clears it');
  assert.equal(validateSchedule({ start_at: at(3) }, { status: 'closed' }, NOW).errors.length, 1);
});

// ── Fresher wording ──

test('soundsLikeFresher: many ways of saying it, in English, Hinglish and Hindi; denials do not count', () => {
  for (const t of ['Main fresher hoon', 'nahi, main fresher hoon', 'I am a student', "I'm still studying", 'I just graduated in June', 'recent graduate hoon',
    'no work experience', 'koi experience nahi hai', 'kabhi job nahi ki', 'This will be my first job', 'मैं फ्रेशर हूँ', 'मेरा कोई अनुभव नहीं है']) {
    assert.equal(soundsLikeFresher(t), true, t);
  }
  for (const t of ['I am not a fresher', 'main fresher nahi hoon', 'I have 3 years of experience', 'Mera notice period 60 din hai', 'I studied at IIT']) {
    assert.equal(soundsLikeFresher(t), false, t);
  }
});

test('saysNoFullTimeJob: the answer to "full-time job before, or fresher?"', () => {
  for (const t of ['no', 'Nahi', 'Nahi, fresher hoon', 'abhi tak nahi', 'not yet', 'नहीं', 'never', 'nahi abhi tak nahi, main final year mein hoon', 'No, I am in my final year of B.Tech']) {
    assert.equal(saysNoFullTimeJob(t), true, t);
  }
  for (const t of ['haan', 'Yes, two years at TCS', 'haan ji, do saal kiya hai', 'No, I am not a fresher', 'हाँ, तीन साल', '']) assert.equal(saysNoFullTimeJob(t), false, t);
});

test('skipForFresher: decided by wording, whatever answer type HR picked', () => {
  const q = (question_text, answer_type = 'text') => skipForFresher({ question_text, answer_type });
  assert.equal(q('Aapka current notice period kitna hai?', 'duration'), true);
  assert.equal(q('How long is your notice period?', 'number'), true);
  assert.equal(q('What is your current salary?'), true);
  assert.equal(q('Aapki abhi ki salary kitni hai?', 'number'), true);
  assert.equal(q('Which company do you work at now? (current company)'), true);
  assert.equal(q('Any salary number', 'ctc'), true, 'a CTC question not about expectations');
  assert.equal(q('Aapki expected CTC kitni hai?', 'ctc'), false);
  assert.equal(q('What salary do you want?', 'ctc'), false);
  assert.equal(q('Kab join kar sakte hain?'), false);
  assert.equal(q('Kya aap Pune relocate kar sakte hain?', 'yes_no'), false);
});

// ── Call order ──

test('plan: project and problem questions in every language; at most three resume questions; experience check only when needed', () => {
  for (const lang of ['mixed', 'en', 'hi']) {
    const p = buildQuestionPlan({ candidate: { name: 'A', resume_questions: [1, 2, 3, 4, 5].map(n => ({ question_text: `R${n}?` })) }, batch: { job_role: 'QA' }, language: lang,
      hrQuestions: [{ question_text: 'Expected CTC?', answer_type: 'ctc', position: 0 }] });
    assert.equal(p.questions[1].question_text, phrases(lang).proudProject);
    assert.equal(p.questions[2].question_text, phrases(lang).problems);
    assert.equal(p.questions.filter(q => q.source === 'resume').length, RESUME_QUESTIONS_IN_CALL);
    assert.ok(!p.questions.some(q => q.experience_check), 'only an expected-CTC question: no need to ask');
  }
  for (const lang of Object.keys(PHRASES)) {
    for (const key of ['proudProject', 'problems', 'experienceCheck']) assert.ok(PHRASES[lang][key].length > 20, `${lang}.${key}`);
  }
});

test('decideTurn: probe reaches the model only when a follow-up is allowed', async () => {
  const calls = [];
  const llm = async (body) => { calls.push(JSON.parse(body.messages[1].content)); return { json: async () => ({ choices: [{ message: { content: '{"action":"next","extracted":{"text":"x"}}' } }] }) }; };
  await decideTurn({ question: 'Project?', transcript: 'ek app', allowFollowUp: true, probe: true }, { llm });
  await decideTurn({ question: 'Project?', transcript: 'ek app', allowFollowUp: false, probe: true }, { llm });
  assert.deepEqual(calls.map(c => c.probe), [true, false]);
});

test('export: project and resume answers share one column', () => {
  const t = exportTable([{ name: 'A', email: 'a@x', status: 'completed', answers: [
    { source: 'general', question_text: 'Proud project?', display: 'Payments app' },
    { source: 'resume', question_text: 'Kafka?', display: 'Lag fix' }
  ] }], []);
  const col = t.headers.indexOf('Project and resume questions and answers');
  assert.ok(col > 0);
  assert.match(t.rows[0][col], /Q1: Proud project\?\nA: Payments app\n\nQ2: Kafka\?\nA: Lag fix/);
});

// ── Google token email (read before the token is checked, only to refuse early) ──

test('unverifiedGoogleEmail reads the email claim, lower-cased; junk gives null', () => {
  const tok = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.s`;
  assert.equal(unverifiedGoogleEmail(tok({ email: ' Asha@QA.test ' })), 'asha@qa.test');
  assert.equal(unverifiedGoogleEmail(tok({ sub: '1' })), null);
  assert.equal(unverifiedGoogleEmail(tok({ email: ['a@b.c'] })), null);
  assert.equal(unverifiedGoogleEmail('not-a-token'), null);
  assert.equal(unverifiedGoogleEmail('a.%%%.c'), null);
  assert.equal(unverifiedGoogleEmail(undefined), null);
});
