// Integration: company briefing, campaign languages, fresher from the resume, follow-up questions,
// Prisma v3.0 requests and pre-voicing (real Express app, fake DB, fake Gnani + LLM; no credits).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from '../helpers/fakeDb.js';
import { net, fakes, resetNetwork } from '../helpers/network.js';
import { speechRetry, clearAudioCache } from '../../../backend/src/services/gnaniSpeech.js';
import { clearBriefingCache, clearTranslationCache } from '../../../backend/src/services/brain.js';
import { startApp, tokens, liveCampaign, takeCall, answerForm, fileForm, RESUME_PDF, HAPPY_ANSWERS } from '../helpers/http.js';

let app, store, c;
const admin = tokens.admin();
const INTRO = 'QA Demo Co builds billing software for 3,000 kirana shops. The backend team of 8 runs the payments platform.';
const waitFor = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => { store = installFakeDb(); resetNetwork(); clearAudioCache(); clearBriefingCache(); clearTranslationCache(); speechRetry.delaysMs = [1, 1]; });

async function candidate(fields = {}) {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }], ...fields });
  return tokens.candidate('cand-asha', 'asha@qa.test');
}

async function readyToCall(tok) {
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
}

const agentLines = () => store.calls.at(-1).transcript.filter(e => e.speaker === 'agent').map(e => e.text);

// ── Company briefing ──

test('company intro: HR saves it, and the agent speaks a briefing right after "ready", before the first question', async () => {
  fakes.llmReply = (kind, user) => (kind === 'other' && user.company_intro
    ? { briefing: `${user.company_name} billing software banata hai. Ab main aapse kuch sawaal poochungi.` } : undefined);
  const tok = await candidate({ company_intro: INTRO });
  assert.equal(store.batches[0].company_intro, INTRO);
  await readyToCall(tok);
  await c.post('/api/candidate/call/start', { token: tok });
  const t1 = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan ready hoon') });
  assert.equal(t1.status, 200);
  assert.equal(t1.body.lines.length, 2, 'briefing + first resume question');
  assert.match(t1.body.lines[0].text, /QA Demo Co billing software banata hai/);
  assert.equal(store.calls[0].question_plan.briefing, t1.body.lines[0].text);
  // Spoken once only: the next answer goes straight to the next question.
  const t2 = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm(HAPPY_ANSWERS[1]) });
  assert.equal(t2.body.lines.length, 1);
});

test('company briefing falls back to HR\'s own intro when the brain gives nothing usable', async () => {
  const tok = await candidate({ company_intro: INTRO });
  await readyToCall(tok);
  await c.post('/api/candidate/call/start', { token: tok });
  const t1 = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan') });
  assert.match(t1.body.lines[0].text, /^Thoda QA Demo Co ke baare mein bata doon: QA Demo Co builds billing software/);
});

test('no company intro: no briefing, the call goes straight to the questions', async () => {
  const tok = await candidate();
  await readyToCall(tok);
  await c.post('/api/candidate/call/start', { token: tok });
  const t1 = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan') });
  assert.equal(t1.body.lines.length, 1);
  assert.equal(store.calls[0].question_plan.briefing, undefined);
});

test('company intro over 1500 characters is refused; PATCH can set and clear it', async () => {
  const created = await c.post('/api/hr/batches', { token: admin, json: { name: 'X', job_role: 'QA', company_intro: 'a'.repeat(1501) } });
  assert.equal(created.status, 400);
  const ok = await c.post('/api/hr/batches', { token: admin, json: { name: 'X', job_role: 'QA', company_intro: INTRO } });
  assert.equal(ok.status, 201);
  assert.equal((await c.patch(`/api/hr/batches/${ok.body.id}`, { token: admin, json: { company_intro: '' } })).body.company_intro, null);
});

// ── Campaign languages ──

test('campaign languages: HR limits them, candidates see only those, and an other choice falls back', async () => {
  const tok = await candidate({ call_languages: ['hi', 'en'] });
  assert.deepEqual(store.batches[0].call_languages, ['en', 'hi'], 'kept in the standard order');
  const me = await c.get('/api/candidate/me', { token: tok });
  assert.deepEqual(me.body.batch.call_languages, ['en', 'hi']);
  await readyToCall(tok);
  const start = await c.post('/api/candidate/call/start', { token: tok, json: { language: 'mixed' } });
  assert.equal(start.status, 200);
  assert.equal(store.calls[0].question_plan.language, 'en', 'English + Hindi is not allowed here, so the first allowed language is used');
});

test('campaign languages: an empty list or an unknown code is refused', async () => {
  const b = await c.post('/api/hr/batches', { token: admin, json: { name: 'L', job_role: 'QA' } });
  assert.deepEqual(b.body.call_languages, ['mixed', 'en', 'hi'], 'all three by default');
  assert.equal((await c.patch(`/api/hr/batches/${b.body.id}`, { token: admin, json: { call_languages: [] } })).status, 400);
  assert.equal((await c.patch(`/api/hr/batches/${b.body.id}`, { token: admin, json: { call_languages: ['fr'] } })).status, 400);
  assert.equal((await c.patch(`/api/hr/batches/${b.body.id}`, { token: admin, json: { call_languages: 'en' } })).status, 400);
});

test('Hindi call: Prisma gets Hindi + English hints and the agent speaks Hindi', async () => {
  const tok = await candidate();
  await readyToCall(tok);
  const start = await c.post('/api/candidate/call/start', { token: tok, json: { language: 'hi' } });
  assert.match(start.body.lines[0].text, /^नमस्ते Asha!/);
  await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('हाँ') });
  assert.equal(net.prismaForms.at(-1).language_code, 'hi-IN,en-IN');
});

// ── Fresher from the resume ──

test('fresher from the resume: saved on the candidate, and notice period / current CTC are left out of the plan', async () => {
  fakes.llmReply = (kind) => (kind === 'resume' ? {
    questions: ['College mein aapne kaunsa final year project banaya?', 'Us project mein aapka role kya tha?', 'Kaunsi technology aapko sabse pasand hai?'],
    is_fresher: true
  } : undefined);
  const tok = await candidate();
  await readyToCall(tok);
  assert.equal(store.candidates[0].is_fresher, true);
  const start = await c.post('/api/candidate/call/start', { token: tok });
  const hr = store.calls[0].question_plan.questions.filter(q => q.source === 'hr').map(q => q.question_text);
  assert.ok(!hr.some(q => /notice period|current CTC/i.test(q)), hr.join(' | '));
  assert.ok(hr.some(q => /expected CTC/i.test(q)));
  // ready + project + problems + 3 resume + 3 HR (no experience check: the resume already says fresher)
  assert.equal(start.body.total_questions, 1 + 2 + 3 + 3);
  assert.ok(!store.calls[0].question_plan.questions.some(q => q.experience_check));
});

test('an unclear resume (is_fresher missing) keeps the full script', async () => {
  const tok = await candidate();
  await readyToCall(tok);
  assert.equal(store.candidates[0].is_fresher, null);
  const start = await c.post('/api/candidate/call/start', { token: tok });
  assert.equal(start.body.total_questions, 12);
});

// ── Follow-up questions ──

test('follow-up: a thin project answer gets one cross-question; both parts are saved as one answer', async () => {
  fakes.llmReply = (kind, user) => {
    if (kind === 'turn' && user.follow_up_allowed && /^bas ek app/.test(user.transcript)) {
      return { action: 'follow_up', extracted: { text: user.transcript }, say: 'Achha, us app mein aapne kaunsi technology use ki?' };
    }
    return undefined;
  };
  const tok = await candidate();
  await readyToCall(tok);
  await c.post('/api/candidate/call/start', { token: tok });
  await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan') });
  const thin = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('bas ek app banaya tha') });
  assert.equal(thin.body.decision, 'follow_up');
  assert.equal(thin.body.position, 1, 'still on the same question');
  assert.equal(thin.body.lines[0].text, 'Achha, us app mein aapne kaunsi technology use ki?');

  const more = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('React Native aur Firebase') });
  assert.equal(more.body.decision, 'next');
  assert.equal(more.body.position, 2);
  const saved = store.answers.find(a => a.position === 1);
  assert.equal(saved.answer_text, 'bas ek app banaya tha / React Native aur Firebase');
  assert.equal(saved.outcome, 'answered');
  assert.equal(saved.attempts, 2);
});

test('follow-up: at most three per call, project questions first, never on the experience check or HR questions', async () => {
  const allowed = [];
  fakes.llmReply = (kind, user) => {
    if (kind !== 'turn') return undefined;
    allowed.push({ q: user.question, allowed: user.follow_up_allowed, probe: user.probe });
    return user.follow_up_allowed ? { action: 'follow_up', extracted: { text: user.transcript }, say: 'Thoda aur detail mein bataiye?' } : undefined;
  };
  const tok = await candidate();
  // ready; project + cross-question; problems + cross-question; resume 1 + follow-up; resume 2 and 3;
  // experience check; 5 HR answers.
  const answers = ['haan', 'g1', 'g1 more', 'g2', 'g2 more', 'r1', 'r1 more', 'r2', 'r3', 'Haan, do saal job ki hai', '60 days', '9 lakh', '12 lakh', 'Pune', 'Do mahine'];
  const last = await takeCall(c, tok, answers);
  assert.equal(last.body.outcome, 'completed', JSON.stringify(last.body));
  const followUps = store.calls[0].transcript.filter(e => e.follow_up).map(e => e.position);
  assert.deepEqual(followUps, [1, 2, 3]);
  assert.deepEqual(allowed.slice(1, 3).map(a => a.probe), [true, true], 'the project questions are cross-questioned');
  assert.ok(allowed.filter(a => /CTC|notice|city|join|full-time/i.test(a.q)).every(a => !a.allowed), 'no follow-up on the experience check or HR questions');
});

test('follow-up: a banned-topic follow-up from the model is not spoken; the answer is accepted', async () => {
  fakes.llmReply = (kind, user) => (kind === 'turn' && user.follow_up_allowed
    ? { action: 'follow_up', extracted: { text: user.transcript }, say: 'Aap married hain kya?' } : undefined);
  const tok = await candidate();
  await readyToCall(tok);
  await c.post('/api/candidate/call/start', { token: tok });
  await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan') });
  const t = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('ek app banaya') });
  assert.equal(t.body.decision, 'next');
  assert.doesNotMatch(agentLines().join(' '), /married/i);
});

// ── Prisma v3.0 ──

test('Prisma v3.0: every answer is sent with model prisma-v3.0, the call context and the question just asked', async () => {
  const tok = await candidate();
  await takeCall(c, tok);
  assert.ok(net.prismaForms.length >= 10);
  for (const f of net.prismaForms) {
    assert.equal(f.model, 'prisma-v3.0');
    assert.equal(f.format, 'transcribe');
    assert.match(f.topic, /Backend Engineer.*QA Demo Co/);
    assert.ok(JSON.parse(f.keyterms).includes('Backend Engineer'));
  }
  assert.equal(net.prismaForms[0].previous_text, 'Kya aap abhi baat karne ke liye ready hain?');
});

test('Prisma v2.5 still works when GNANI_STT_MODEL says so: no model field, no v3 context', async () => {
  process.env.GNANI_STT_MODEL = 'prisma-v2.5';
  try {
    const tok = await candidate();
    await readyToCall(tok);
    await c.post('/api/candidate/call/start', { token: tok, json: { language: 'hi' } });
    await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan') });
    const f = net.prismaForms.at(-1);
    assert.equal(f.model, null);
    assert.equal(f.language_code, 'hi-IN', 'v2.5 takes one language');
    assert.equal(f.topic, null);
  } finally {
    delete process.env.GNANI_STT_MODEL;
  }
});

// ── Pre-voicing ──

test('running a campaign voices its shared lines in the background, in each allowed language', async () => {
  process.env.PREVOICE_ON_RUN = '1';
  try {
    await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }], call_languages: ['mixed', 'en'], company_intro: INTRO });
    assert.ok(await waitFor(() => net.timbreTexts.includes('Aapki expected CTC kitni hai?') && net.timbreTexts.includes('Are you ready to talk now?')),
      `voiced: ${net.timbreTexts.join(' | ')}`);
    assert.ok(net.timbreTexts.some(t => t.startsWith('Thoda QA Demo Co ke baare mein')), 'the briefing is voiced too');
    assert.ok(!net.timbreTexts.some(t => /नमस्ते|क्या आप/.test(t)), 'Hindi is not allowed, so it is not voiced');

    // The first call then gets the shared lines from the cache.
    await waitFor(() => net.active.timbre === 0);
    const before = net.timbre;
    const tok = tokens.candidate('cand-asha', 'asha@qa.test');
    await readyToCall(tok);
    await c.post('/api/candidate/call/start', { token: tok });
    assert.equal(net.timbre - before, 1, 'only the greeting (it has the name) is new');
  } finally {
    process.env.PREVOICE_ON_RUN = '0';
  }
});
