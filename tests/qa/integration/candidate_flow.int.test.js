// Integration: the candidate journey over HTTP (real Express app, fake DB, fake Gnani + LLM).
// Tests marked { todo: 'BUG-xx' } are TDD "red" tests: they describe the correct behaviour, fail today,
// and turn green when the bug in the QA report is fixed. They are reported but do not fail the suite.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from '../helpers/fakeDb.js';
import { net, fakes, resetNetwork } from '../helpers/network.js';
import { speechRetry, clearAudioCache } from '../../../backend/src/services/gnaniSpeech.js';
import { startApp, tokens, liveCampaign, takeCall, answerForm, fileForm, RESUME_PDF, HAPPY_ANSWERS, WEBM_SAMPLE } from '../helpers/http.js';

let app, store, c;
const admin = tokens.admin();
const waitFor = async (check, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => { store = installFakeDb(); resetNetwork(); clearAudioCache(); speechRetry.delaysMs = [1, 1]; });

async function candidate(email = 'asha@qa.test', id = 'cand-asha') {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email }] });
  return tokens.candidate(id, email);
}

test('happy path: resume → consent → full call → completed with values, summary and results', async () => {
  const tok = await candidate();
  const me = await c.get('/api/candidate/me', { token: tok });
  assert.equal(me.status, 200);
  assert.equal(me.body.status, 'invited');

  const last = await takeCall(c, tok);
  assert.equal(last.status, 200, JSON.stringify(last.body));
  assert.equal(last.body.done, true);
  assert.equal(last.body.outcome, 'completed');
  assert.equal(last.start.body.total_questions, 12);

  assert.ok(await waitFor(() => store.calls[0]?.summary), 'summary is written in the background');
  assert.equal(store.calls[0].fit_score, 72);
  assert.equal(store.candidates[0].status, 'completed');

  const batchId = store.batches[0].id;
  const results = await c.get(`/api/hr/batches/${batchId}/results`, { token: admin });
  const row = results.body.rows[0];
  assert.equal(row.notice_period_days, 60);
  assert.equal(row.current_ctc_lpa, 9);
  assert.equal(row.expected_ctc_lpa, 12);
  assert.equal(row.answers.length, 12);

  // Credits a single complete call uses (fake counters): one STT per spoken answer.
  assert.equal(net.prisma, 12);
  assert.equal(net.refused.length, 0, 'no request left the machine');
  assert.equal(net.maxActive.prisma, 1, 'never more than one Prisma request at a time');
  assert.equal(net.maxActive.timbre, 1, 'never more than one Timbre request at a time');
});

test('the browser cannot skip questions: state lives on the server', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  const start = await c.post('/api/candidate/call/start', { token: tok });
  assert.equal(start.body.position, 0);
  const t1 = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan') });
  assert.equal(t1.body.position, 1);
});

test('consent is required before the call and must be explicit', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  assert.equal((await c.post('/api/candidate/consent', { token: tok, json: { agree: 'yes' } })).status, 400);
  assert.equal((await c.post('/api/candidate/call/start', { token: tok })).status, 400);
});

test('resume must be a real PDF; non-PDF bytes are refused', async () => {
  const tok = await candidate();
  const r = await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', Buffer.from('<html>not a pdf</html>'), 'r.pdf', 'application/pdf') });
  assert.equal(r.status, 400);
});

test('silence twice on a question skips it; the call continues', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: tok });
  const s1 = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('') });
  assert.equal(s1.body.decision, 'repeat');
  const s2 = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('') });
  assert.equal(s2.body.decision, 'skip');
  assert.equal(s2.body.position, 1);
});

test('"not ready" ends politely, returns the candidate to resume_uploaded and does not use an attempt', async () => {
  const tok = await candidate();
  await takeCall(c, tok, ['nahi abhi nahi']);
  assert.equal(store.candidates[0].status, 'resume_uploaded');
  assert.equal(store.calls[0].failure_reason, 'The candidate was not ready to talk.');
});

test('BUG-07 (fixed 27 Oct): "not ready" can be repeated forever, each time spending Timbre/LLM credits', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  let started = 0;
  for (let i = 0; i < 8; i += 1) {
    const s = await c.post('/api/candidate/call/start', { token: tok });
    if (s.status !== 200) break;
    started += 1;
    await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('nahi') });
  }
  assert.ok(started <= 3, `expected a cap on not-ready restarts, but ${started} calls were started`);
});

test('a second tab cannot start a second call at the same time', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  const [a, b] = await Promise.all([c.post('/api/candidate/call/start', { token: tok }), c.post('/api/candidate/call/start', { token: tok })]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(store.calls.length, 1);
});

test('BUG-05 (fixed 27 Oct): two /turn requests at once (double click, retry) are both processed and race on the transcript', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: tok });
  const before = net.prisma;
  const [a, b] = await Promise.all([
    c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan ready') }),
    c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan ready') })
  ]);
  const ok = [a, b].filter(r => r.status === 200).length;
  assert.equal(ok, 1, `exactly one turn should be processed, got ${ok}`);
  assert.equal(net.prisma - before, 1, 'the duplicate should not spend a second Prisma request');
});

test('BUG-06 (fixed 27 Oct): /end with reason "constructor" stores a broken failure reason instead of the default', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: tok });
  const r = await c.post('/api/candidate/call/end', { token: tok, json: { reason: 'constructor' } });
  assert.equal(r.status, 200);
  assert.match(String(store.calls[0].failure_reason), /technical problem/);
});

test('/end with an unknown reason falls back to the technical-problem text', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: tok });
  await c.post('/api/candidate/call/end', { token: tok, json: { reason: 'whatever' } });
  assert.match(store.calls[0].failure_reason, /technical problem/);
  assert.equal(store.candidates[0].status, 'failed');
});

test('self-retry is limited to 3 calls in total; HR Retake gives one more', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await c.post('/api/candidate/call/start', { token: tok })).status, 200, `start ${i + 1}`);
    await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan') });
    await c.post('/api/candidate/call/end', { token: tok, json: { reason: 'ended_by_candidate' } });
    if (i < 2) assert.equal((await c.post('/api/candidate/call/retry', { token: tok })).status, 200);
  }
  assert.equal((await c.post('/api/candidate/call/retry', { token: tok })).status, 409);
  const cand = store.candidates[0];
  assert.equal((await c.post(`/api/hr/candidates/${cand.id}/allow-retake`, { token: admin })).status, 200);
  assert.equal((await c.post('/api/candidate/call/start', { token: tok })).status, 200);
});

test('recording upload: only after the call, only once, only audio types', async () => {
  const tok = await candidate();
  await takeCall(c, tok);
  const bad = await c.post('/api/candidate/call/recording', { token: tok, form: fileForm('recording', Buffer.from('x'), 'r.txt', 'text/plain') });
  assert.equal(bad.status, 400);
  const ok = await c.post('/api/candidate/call/recording', { token: tok, form: fileForm('recording', WEBM_SAMPLE, 'r.webm', 'audio/webm') });
  assert.equal(ok.status, 200);
  const again = await c.post('/api/candidate/call/recording', { token: tok, form: fileForm('recording', WEBM_SAMPLE, 'r.webm', 'audio/webm') });
  assert.equal(again.status, 409);
});

test('BUG-08 (fixed 27 Oct): any file labelled audio/webm is stored as the call recording (no content check)', async () => {
  const tok = await candidate();
  await takeCall(c, tok);
  const html = Buffer.from('<html><script>alert(1)</script></html>');
  const r = await c.post('/api/candidate/call/recording', { token: tok, form: fileForm('recording', html, 'r.webm', 'audio/webm') });
  assert.equal(r.status, 400, 'non-audio bytes should be refused');
});

test('closed or draft campaigns: no resume upload, no call', async () => {
  const tok = await candidate();
  const batchId = store.batches[0].id;
  await c.post(`/api/hr/batches/${batchId}/close`, { token: admin });
  assert.equal((await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') })).status, 409);
  assert.equal((await c.post('/api/candidate/call/start', { token: tok })).status, 409);

  store.batches[0].status = 'draft';
  assert.equal((await c.get('/api/candidate/me', { token: tok })).status, 404, 'draft campaigns are invisible');
});

test('a call idle for more than 3 minutes is marked failed on the next visit', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: tok });
  const old = new Date(Date.now() - 4 * 60 * 1000).toISOString();
  store.calls[0].started_at = old;
  store.calls[0].transcript.forEach(e => { e.at = old; });
  const me = await c.get('/api/candidate/me', { token: tok });
  assert.equal(me.body.status, 'failed');
  assert.equal(store.calls[0].status, 'failed');
});

test('candidates only ever see their own record; HR data (score, summary) is not in /me', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }, { name: 'Ravi K', email: 'ravi@qa.test' }] });
  const asha = tokens.candidate('u-asha', 'asha@qa.test');
  const ravi = tokens.candidate('u-ravi', 'ravi@qa.test');
  const stranger = tokens.candidate('u-x', 'stranger@qa.test');
  await takeCall(c, asha);
  const meRavi = await c.get('/api/candidate/me', { token: ravi });
  assert.equal(meRavi.body.name, 'Ravi K');
  assert.equal((await c.get('/api/candidate/me', { token: stranger })).status, 404);
  const meAsha = await c.get('/api/candidate/me', { token: asha });
  assert.equal(meAsha.body.fit_score, undefined);
  assert.equal(meAsha.body.summary, undefined);
});

test('Prisma refusing twice (403) is retried; a persistent failure counts as unheard, not as a crash', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: tok });
  fakes.fail = (svc) => (svc === 'prisma' ? 403 : null);
  const t = await c.post('/api/candidate/call/turn', { token: tok, form: answerForm('haan') });
  assert.equal(t.status, 200);
  assert.equal(t.body.speech_error, true);
  assert.equal(t.body.decision, 'repeat');
  assert.equal(net.prisma, 3, 'one try plus two retries');
});

test('BUG-14: when the LLM is down, every answer is accepted as-is (garbage in, "answered" out)', { todo: 'BUG-14 brain-down fallback accepts anything' }, async () => {
  const tok = await candidate();
  fakes.fail = (svc) => (svc === 'llm' ? 503 : null);
  const last = await takeCall(c, tok, ['haan', 'asdf qwerty', 'zzz', 'blah blah', 'hmm ok', 'pata nahi', 'kuch bhi', 'no idea', 'xyz', 'ok']);
  assert.equal(last.body.outcome, 'completed');
  const answered = store.answers.filter(a => a.outcome === 'answered' && a.source === 'hr' && a.answer_type === 'duration');
  assert.equal(answered.length, 0, 'an unreadable notice period should not be stored as answered');
});

test('the full happy path never calls a non-local host', async () => {
  const tok = await candidate();
  await takeCall(c, tok, HAPPY_ANSWERS);
  assert.deepEqual(net.refused, []);
});

test('BUG-43 (fixed 1 Nov): a candidate who says they are a fresher is not asked notice period or current CTC', async () => {
  const tok = await candidate();
  // "Fresher" in the project answer; afterwards the problems and resume questions, then only expected CTC,
  // city and joining (no experience check, no notice period, no current CTC).
  const answers = ['haan ready hoon', 'Main fresher hoon, college mein ek chat app banaya tha', 'Socket connection drop hota tha, maine reconnect logic likha',
    'Frontend kiya tha', 'React pasand hai', 'Ek bug fix kiya tha', '6 lakh', 'Pune', 'Turant join kar sakta hoon'];
  const last = await takeCall(c, tok, answers);
  assert.equal(last.body.outcome, 'completed', JSON.stringify(last.body));

  const spoken = store.calls[0].transcript.filter(e => e.speaker === 'agent').map(e => e.text).join(' | ');
  assert.doesNotMatch(spoken, /notice period/i);
  assert.doesNotMatch(spoken, /current CTC/i);
  assert.match(spoken, /expected CTC/i);

  const results = await c.get(`/api/hr/batches/${store.batches[0].id}/results`, { token: admin });
  const row = results.body.rows[0];
  assert.equal(row.notice_period_days, null);
  assert.equal(row.current_ctc_lpa, null);
  assert.equal(row.expected_ctc_lpa, 6);
  const notAsked = row.answers.filter(a => a.display === 'Not asked (fresher)').map(a => a.question_text);
  assert.deepEqual(notAsked, ['Kya aapne pehle kisi company mein full-time job ki hai, ya aap fresher hain?', 'Aapka current notice period kitna hai?', 'Aapki current CTC kitni hai?']);
});

test('a "not a fresher" answer keeps the full script', async () => {
  const tok = await candidate();
  const answers = ['haan', 'Main fresher nahi hoon, 3 saal ka experience hai', ...HAPPY_ANSWERS.slice(2)];
  const last = await takeCall(c, tok, answers);
  assert.equal(last.body.outcome, 'completed');
  const results = await c.get(`/api/hr/batches/${store.batches[0].id}/results`, { token: admin });
  assert.equal(results.body.rows[0].notice_period_days, 60);
  assert.equal(results.body.rows[0].current_ctc_lpa, 9);
});

test('call language: English is saved on the call and the agent speaks English; unknown codes fall back to English + Hindi', async () => {
  const tok = await candidate();
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  const start = await c.post('/api/candidate/call/start', { token: tok, json: { language: 'en' } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(store.calls[0].question_plan.language, 'en');
  assert.match(start.body.lines[0].text, /^Hello Asha!/);
  assert.equal(start.body.lines[1].text, 'Are you ready to talk now?');
  // HR wording is kept for results, whatever language the call is in.
  assert.ok(store.calls[0].question_plan.questions.some(q => q.question_text === 'Aapki expected CTC kitni hai?'));

  await c.post('/api/candidate/call/end', { token: tok, json: { reason: 'ended_by_candidate' } });
  await c.post('/api/candidate/call/retry', { token: tok });
  const again = await c.post('/api/candidate/call/start', { token: tok, json: { language: 'klingon' } });
  assert.equal(again.status, 200);
  assert.equal(store.calls[1].question_plan.language, 'mixed');
  assert.match(again.body.lines[0].text, /^Namaste Asha!/);
});
