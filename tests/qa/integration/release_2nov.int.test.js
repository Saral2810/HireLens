// Integration (2 Nov changes): candidate sign-in without the Supabase address (Google ID token,
// server-side invite sessions), no list of earlier screenings, campaign scheduling, the new call
// order (briefing → project → problems → resume → HR) and the fresher rule. Includes the
// security checks for each new endpoint. Fake DB, fake SMTP, fake Gnani + LLM; no credits.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { installFakeDb } from '../helpers/fakeDb.js';
import { installFakeMail, tokenOf } from '../helpers/mail.js';
import { net, fakes, resetNetwork } from '../helpers/network.js';
import { speechRetry, clearAudioCache } from '../../../backend/src/services/gnaniSpeech.js';
import { clearBriefingCache, clearTranslationCache } from '../../../backend/src/services/brain.js';
import { runningInviteJobs } from '../../../backend/src/services/candidateInvites.js';
import { runDueSchedules } from '../../../backend/src/services/campaignScheduler.js';
import { useTestTransport } from '../../../backend/src/services/mailer.js';
import db from '../../../backend/src/config/db.js';
import { startApp, tokens, liveCampaign, answerForm, fileForm, RESUME_PDF } from '../helpers/http.js';

let app, store, c, mail;
const admin = tokens.admin();
const recA = tokens.recruiter('rec-a');
const recB = tokens.recruiter('rec-b');
const CLIENT_ID = '123456-qa.apps.googleusercontent.com';
const HOUR = 3600 * 1000;
const settle = () => Promise.all([...runningInviteJobs]);

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => {
  store = installFakeDb(); resetNetwork(); clearAudioCache(); clearBriefingCache(); clearTranslationCache();
  speechRetry.delaysMs = [1, 1]; mail = installFakeMail(); process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
});
afterEach(() => { useTestTransport(null); delete process.env.GOOGLE_CLIENT_ID; });

/** A fake Google ID token as the fake DB accepts it (see helpers/fakeDb.js). */
function googleToken({ email, nonce, aud = CLIENT_ID, sig = 'qa-google-sig' }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc({ email, aud, nonce: crypto.createHash('sha256').update(nonce).digest('hex'), name: 'Asha Rao' })}.${sig}`;
}
const NONCE = 'qa-nonce-0123456789abcdef';
const google = (body) => c.post('/api/auth/google/token', { json: body });

async function draftWithPeople(token = admin, people = [{ name: 'Asha Rao', email: 'asha@qa.test' }]) {
  const batch = (await c.post('/api/hr/batches', { token, json: { name: 'Sched', job_role: 'Backend Engineer', company_name: 'QA Demo Co' } })).body;
  await c.post(`/api/hr/batches/${batch.id}/questions/defaults`, { token });
  if (people.length) await c.post(`/api/hr/batches/${batch.id}/candidates`, { token, json: { candidates: people } });
  return batch;
}
const inHours = (h) => new Date(Date.now() + h * HOUR).toISOString();

// ── 1. Sign-in without the Supabase address ──

test('Google ID token: an invited candidate is signed in and linked to their screening', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }] });
  const r = await google({ credential: googleToken({ email: 'asha@qa.test', nonce: NONCE }), nonce: NONCE });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.user.email, 'asha@qa.test');
  assert.equal(store.candidates[0].user_id, r.body.user.id);
  assert.equal((await c.get('/api/candidate/me', { token: r.body.token })).status, 200);
});

test('Google ID token: a replayed token (wrong nonce), a token for another app or a forged signature is refused', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }] });
  const replay = await google({ credential: googleToken({ email: 'asha@qa.test', nonce: NONCE }), nonce: 'a-different-nonce-123456' });
  assert.equal(replay.status, 401);
  const otherApp = await google({ credential: googleToken({ email: 'asha@qa.test', nonce: NONCE, aud: 'evil.apps.googleusercontent.com' }), nonce: NONCE });
  assert.equal(otherApp.status, 401);
  const forged = await google({ credential: googleToken({ email: 'asha@qa.test', nonce: NONCE, sig: 'forged' }), nonce: NONCE });
  assert.equal(forged.status, 401);
  assert.equal(store.candidates[0].user_id, null, 'nobody was linked');
});

test('Google ID token: HR accounts and emails without a live screening are refused before any account is made, with one answer for all', async () => {
  store.addProfile({ id: 'hr-1', email: 'boss@qa.test', role: 'superadmin' });
  const hr = await google({ credential: googleToken({ email: 'boss@qa.test', nonce: NONCE }), nonce: NONCE });
  assert.equal(hr.status, 401);
  const stranger = await google({ credential: googleToken({ email: 'nobody@qa.test', nonce: NONCE }), nonce: NONCE });
  assert.equal(stranger.status, 401);
  // A made-up, unsigned token for an invited email gets the very same answer: no way to probe emails.
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }] });
  const probe = await google({ credential: googleToken({ email: 'asha@qa.test', nonce: NONCE, sig: 'made-up' }), nonce: NONCE });
  assert.deepEqual([probe.status, probe.body], [hr.status, hr.body]);
  assert.deepEqual(stranger.body, hr.body);
  assert.equal(probe.headers.get('cache-control'), 'no-store');
  assert.equal(store.authUsers.filter(u => u.email !== 'asha@qa.test').length, 0, 'no auth user was created');
  // A draft (or scheduled) campaign does not count yet.
  await draftWithPeople(admin, [{ name: 'Later', email: 'later@qa.test' }]);
  assert.equal((await google({ credential: googleToken({ email: 'later@qa.test', nonce: NONCE }), nonce: NONCE })).status, 401);
});

test('Google ID token: bad input is refused; not configured → 503; the endpoint is rate-limited', async () => {
  for (const body of [{}, { credential: 'abc', nonce: NONCE }, { credential: 'a.b.c', nonce: 'short' }, { credential: ['a.b.c'], nonce: NONCE },
    { credential: `${'x'.repeat(5000)}.b.c`, nonce: NONCE }, { credential: 'a.b.c', nonce: 'has spaces in it!!' }]) {
    assert.equal((await google(body)).status, 400, JSON.stringify(body).slice(0, 80));
  }
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal((await google({ credential: 'a.b.c', nonce: NONCE })).status, 503);
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  const statuses = [];
  for (let i = 0; i < 35; i += 1) statuses.push((await google({ credential: 'a.b.c', nonce: NONCE })).status);
  assert.ok(statuses.includes(429), statuses.join(','));
});

test('HR "copy link" gives the personal /join link on the app address; opening it signs in on the server', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }] });
  const r = await c.post(`/api/hr/candidates/${store.candidates[0].id}/invite-link`, { token: admin });
  assert.equal(r.status, 200);
  assert.match(r.body.invite_link, /^http:\/\/qa\.localhost\/join\?t=/);
  assert.doesNotMatch(r.body.invite_link, /supabase|auth\/v1/);
  const joined = await c.post('/api/auth/join', { json: { token: tokenOf(r.body.invite_link) } });
  assert.equal(joined.status, 200);
  assert.ok(joined.body.token);
  assert.doesNotMatch(JSON.stringify(joined.body), /supabase|redirect/i);
});

test('the /join link never signs anyone in as HR, and a tampered token is refused', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }] });
  const link = (await c.post(`/api/hr/candidates/${store.candidates[0].id}/invite-link`, { token: admin })).body.invite_link;
  const t = tokenOf(link);
  const tampered = t.slice(0, -2) + (t.endsWith('A') ? 'BB' : 'AA');
  assert.equal((await c.post('/api/auth/join', { json: { token: tampered } })).status, 400);
  // The candidate's email now belongs to an HR account: no session.
  store.profiles.push({ id: 'hr-x', email: 'asha@qa.test', role: 'recruiter' });
  const r = await c.post('/api/auth/join', { json: { token: t } });
  assert.notEqual(r.status, 200);
  assert.equal(r.body.token, undefined);
});

// ── 2. No list of earlier screenings ──

test('the endpoint that listed a candidate\'s other screenings is gone', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }] });
  const r = await c.get('/api/candidate/screenings', { token: tokens.candidate('cand-asha', 'asha@qa.test') });
  assert.equal(r.status, 404);
});

// ── 3. Scheduling ──

test('schedule: a draft gets a start (and close) time; candidates cannot see it yet', async () => {
  const batch = await draftWithPeople();
  const r = await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: admin, json: { start_at: inHours(24), close_at: inHours(72) } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.status, 'draft');
  assert.ok(Math.abs(Date.parse(r.body.scheduled_at) - Date.parse(inHours(24))) < 60000);
  assert.ok(r.body.closes_at);
  assert.equal(mail.sent.length, 0, 'no emails before the day');
  assert.equal(await db.hasLiveScreening('asha@qa.test'), false, 'not visible to candidates yet');
});

test('schedule: past, too far, garbage, close-before-start, no candidates and closed campaigns are refused', async () => {
  const batch = await draftWithPeople();
  const bad = [
    { start_at: inHours(-1) }, { start_at: inHours(24 * 181) }, { start_at: 'tomorrow-ish' }, { start_at: 12345 }, {},
    { start_at: inHours(5), close_at: inHours(4) }, { start_at: inHours(5), close_at: 'x' }, { start_at: 'x'.repeat(100) }
  ];
  for (const body of bad) {
    assert.equal((await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: admin, json: body })).status, 400, JSON.stringify(body).slice(0, 60));
  }
  const empty = await draftWithPeople(admin, []);
  const r = await c.post(`/api/hr/batches/${empty.id}/schedule`, { token: admin, json: { start_at: inHours(2) } });
  assert.equal(r.status, 400);
  assert.match(r.body.message, /candidate/);
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await c.post(`/api/hr/batches/${batch.id}/close`, { token: admin });
  assert.equal((await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: admin, json: { start_at: inHours(2) } })).status, 400);
});

test('schedule: a running campaign takes only a close time', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }] });
  const id = store.batches[0].id;
  assert.equal((await c.post(`/api/hr/batches/${id}/schedule`, { token: admin, json: { start_at: inHours(2) } })).status, 400);
  const r = await c.post(`/api/hr/batches/${id}/schedule`, { token: admin, json: { close_at: inHours(48) } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'live');
  assert.ok(r.body.closes_at);
});

test('schedule: only the campaign owner (or Admin) can schedule; PATCH cannot set schedule or status fields', async () => {
  const batch = await draftWithPeople(recA);
  assert.equal((await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: recB, json: { start_at: inHours(2) } })).status, 404);
  assert.equal((await c.del(`/api/hr/batches/${batch.id}/schedule`, { token: recB })).status, 404);
  assert.equal((await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: tokens.candidate('c1', 'asha@qa.test'), json: { start_at: inHours(2) } })).status, 403);
  assert.equal((await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: recA, json: { start_at: inHours(2) } })).status, 200);
  await c.patch(`/api/hr/batches/${batch.id}`, { token: recA, json: { name: 'Renamed', scheduled_at: inHours(-5), status: 'live', closes_at: inHours(-1) } });
  const b = store.batches[0];
  assert.equal(b.status, 'draft');
  assert.ok(Date.parse(b.scheduled_at) > Date.now(), 'the start time was not moved by PATCH');
  assert.equal(b.closes_at, null);
});

test('scheduler: on the day the campaign goes live and every candidate is emailed, exactly once', async () => {
  const batch = await draftWithPeople(admin, [{ name: 'Asha Rao', email: 'asha@qa.test' }, { name: 'Ravi K', email: 'ravi@qa.test' }]);
  await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: admin, json: { start_at: inHours(1), close_at: inHours(5) } });
  // Not yet due.
  assert.deepEqual((await runDueSchedules({ now: new Date() })).started, []);
  const due = new Date(Date.now() + 2 * HOUR);
  const [first, second] = await Promise.all([runDueSchedules({ now: due }), runDueSchedules({ now: due })]);
  await Promise.all([...first.emails, ...second.emails]);
  await settle();
  assert.deepEqual([...first.started, ...second.started], [batch.id], 'started once even when two checks race');
  const b = store.batches[0];
  assert.equal(b.status, 'live');
  assert.equal(b.scheduled_at, null);
  assert.ok(b.launched_at);
  assert.deepEqual(mail.sent.map(m => m.to).sort(), ['asha@qa.test', 'ravi@qa.test']);
  assert.ok(mail.sent.every(m => /^http:\/\/qa\.localhost\/join\?t=/.test(m.link)));
  // Close time.
  const closed = await runDueSchedules({ now: new Date(Date.now() + 6 * HOUR) });
  assert.deepEqual(closed.closed, [batch.id]);
  assert.equal(store.batches[0].status, 'closed');
  assert.equal(store.batches[0].closes_at, null);
});

test('scheduler: a due campaign with no candidates is not started; without PUBLIC_APP_URL it starts but sends nothing', async () => {
  const batch = await draftWithPeople();
  await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: admin, json: { start_at: inHours(1) } });
  store.candidates = [];
  const r = await runDueSchedules({ now: new Date(Date.now() + 2 * HOUR) });
  assert.deepEqual(r.skipped.map(s => s.id), [batch.id]);
  assert.equal(store.batches[0].status, 'draft');
  assert.equal(store.batches[0].scheduled_at, null);

  const saved = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = '';
  try {
    const b2 = await draftWithPeople(admin, [{ name: 'Ravi K', email: 'ravi@qa.test' }]);
    await c.post(`/api/hr/batches/${b2.id}/schedule`, { token: admin, json: { start_at: inHours(1) } });
    const r2 = await runDueSchedules({ now: new Date(Date.now() + 2 * HOUR) });
    assert.deepEqual(r2.started, [b2.id]);
    assert.equal(mail.sent.length, 0);
  } finally { process.env.PUBLIC_APP_URL = saved; }
});

test('"Run now" and "Close" clear the schedule; DELETE removes it', async () => {
  const batch = await draftWithPeople();
  await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: admin, json: { start_at: inHours(3) } });
  assert.equal((await c.del(`/api/hr/batches/${batch.id}/schedule`, { token: admin })).body.scheduled_at, null);
  await c.post(`/api/hr/batches/${batch.id}/schedule`, { token: admin, json: { start_at: inHours(3) } });
  const run = await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  assert.equal(run.body.status, 'live');
  assert.equal(run.body.scheduled_at, null);
  // The scheduler then has nothing to do for it.
  assert.deepEqual((await runDueSchedules({ now: new Date(Date.now() + 4 * HOUR) })).started, []);
});

// ── 4. Call order and the fresher rule ──

async function candidateInCall(fields = {}) {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }], ...fields });
  const tok = tokens.candidate('cand-asha', 'asha@qa.test');
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: tok });
  return tok;
}
const turn = (tok, text) => c.post('/api/candidate/call/turn', { token: tok, form: answerForm(text) });
const lastLine = (r) => r.body.lines.at(-1).text;

test('call order: ready → company briefing + proud project → problems → resume → experience check → HR', async () => {
  const seen = [];
  fakes.llmReply = (kind, user) => { if (kind === 'turn') seen.push({ q: user.question, probe: user.probe }); return undefined; };
  const tok = await candidateInCall({ company_intro: 'QA Demo Co builds billing software for kirana shops.' });
  const t1 = await turn(tok, 'haan');
  assert.match(t1.body.lines[0].text, /QA Demo Co ke baare mein/, 'the company briefing comes first');
  assert.match(lastLine(t1), /sabse zyada garv/);
  const t2 = await turn(tok, 'Payments app banaya, main backend lead tha');
  assert.match(lastLine(t2), /sabse badi problem/);
  const t3 = await turn(tok, 'Database slow tha, maine indexing ki');
  assert.match(lastLine(t3), /\(resume \d+\)/, 'then the tailored resume questions');
  await turn(tok, 'r1'); await turn(tok, 'r2');
  const t6 = await turn(tok, 'r3');
  assert.match(lastLine(t6), /full-time job ki hai, ya aap fresher/);
  const t7 = await turn(tok, 'Haan, do saal Infosys mein job ki hai');
  assert.equal(lastLine(t7), 'Aapka current notice period kitna hai?', 'an experienced candidate gets the HR questions');
  assert.deepEqual(seen.slice(1, 3).map(s => s.probe), [true, true], 'the project and problem answers are cross-questioned');
});

test('fresher: "nahi, fresher hoon" to the experience check → no notice period, no current CTC', async () => {
  const tok = await candidateInCall();
  for (const a of ['haan', 'College project', 'Bug tha', 'r1', 'r2', 'r3']) await turn(tok, a);
  const r = await turn(tok, 'Nahi, main fresher hoon');
  assert.equal(lastLine(r), 'Aapki expected CTC kitni hai?');
  const notAsked = store.answers.filter(a => a.extracted_value?.not_asked === 'fresher').map(a => a.question_text);
  assert.deepEqual(notAsked, ['Aapka current notice period kitna hai?', 'Aapki current CTC kitni hai?']);
});

test('fresher: a plain "no" to the experience check works even when the LLM is down', async () => {
  const tok = await candidateInCall();
  for (const a of ['haan', 'College project', 'Bug tha', 'r1', 'r2', 'r3']) await turn(tok, a);
  fakes.fail = (service) => (service === 'llm' ? 500 : null);
  const r = await turn(tok, 'no');
  assert.equal(lastLine(r), 'Aapki expected CTC kitni hai?');
});

test('fresher: saying it AT the notice question moves on (no repeat) and skips current CTC', async () => {
  const tok = await candidateInCall();
  for (const a of ['haan', 'College project', 'Bug tha', 'r1', 'r2', 'r3', 'haan ji']) await turn(tok, a);
  // The fake brain asks again for a duration it cannot read; the fresher rule must win.
  const r = await turn(tok, 'Sir main abhi fresher hoon, koi notice period nahi hai');
  assert.equal(r.body.decision, 'next');
  assert.equal(lastLine(r), 'Aapki expected CTC kitni hai?');
  const notice = store.answers.find(a => a.question_text === 'Aapka current notice period kitna hai?');
  assert.equal(notice.extracted_value.not_asked, 'fresher');
  assert.match(notice.answer_text, /fresher/);
  const spoken = store.calls[0].transcript.filter(e => e.speaker === 'agent').map(e => e.text);
  assert.ok(!spoken.includes('Aapki current CTC kitni hai?'));
});

test('fresher: other ways of saying it ("I am a student", "no work experience") count; "not a fresher" does not', async () => {
  for (const [said, skipped] of [['I am a student, final year B.Tech', true], ['I have no work experience yet', true], ['I am not a fresher, I have 3 years experience', false]]) {
    store = installFakeDb(); resetNetwork();
    const tok = await candidateInCall();
    await turn(tok, 'haan');
    await turn(tok, said);
    for (const a of ['Bug tha', 'r1', 'r2', 'r3']) await turn(tok, a);
    const plan = store.calls[0].question_plan.questions;
    const askedCheck = store.calls[0].transcript.some(e => e.speaker === 'agent' && e.text === plan.find(q => q.experience_check).question_text);
    assert.equal(!askedCheck, skipped, said);
  }
});

test('fresher: an HR question worded "current salary" (free answer type) is skipped too', async () => {
  const batch = (await c.post('/api/hr/batches', { token: admin, json: { name: 'X', job_role: 'Intern', company_name: 'QA Demo Co' } })).body;
  await c.post(`/api/hr/batches/${batch.id}/questions`, { token: admin, json: { question_text: 'What is your current salary?', answer_type: 'text' } });
  await c.post(`/api/hr/batches/${batch.id}/questions`, { token: admin, json: { question_text: 'Which city are you in?', answer_type: 'text' } });
  await c.post(`/api/hr/batches/${batch.id}/candidates`, { token: admin, json: { candidates: [{ name: 'Asha Rao', email: 'asha@qa.test' }] } });
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  const tok = tokens.candidate('cand-asha', 'asha@qa.test');
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: tok });
  for (const a of ['haan', 'Main fresher hoon, college app banaya', 'Bug tha', 'r1', 'r2']) await turn(tok, a);
  const r = await turn(tok, 'r3');
  assert.equal(lastLine(r), 'Which city are you in?');
});
