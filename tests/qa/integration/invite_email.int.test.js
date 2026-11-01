// Integration: invite emails end to end over HTTP — HR runs a campaign → every candidate gets an email
// with a personal link → the link signs them in → they take the call. Fake DB, fake SMTP, fake Gnani/LLM.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from '../helpers/fakeDb.js';
import { installFakeMail, tokenOf } from '../helpers/mail.js';
import { net, resetNetwork } from '../helpers/network.js';
import { speechRetry, clearAudioCache } from '../../../backend/src/services/gnaniSpeech.js';
import { runningInviteJobs } from '../../../backend/src/services/candidateInvites.js';
import { createInviteToken } from '../../../backend/src/services/inviteToken.js';
import { useTestTransport, useTestFetch } from '../../../backend/src/services/mailer.js';
import { startApp, tokens, takeCall } from '../helpers/http.js';

let app, store, c, mail;
const admin = tokens.admin();
const recA = tokens.recruiter('rec-a');
const recB = tokens.recruiter('rec-b');
const people = (n, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ name: `Person${i + 1} Test`, email: `${prefix}${i + 1}@qa.test` }));
const settle = () => Promise.all([...runningInviteJobs]);

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => { store = installFakeDb(); resetNetwork(); clearAudioCache(); speechRetry.delaysMs = [1, 1]; mail = installFakeMail(); });
afterEach(() => useTestTransport(null));

async function campaign(token = admin, list = people(3)) {
  const batch = (await c.post('/api/hr/batches', { token, json: { name: 'Email campaign', job_role: 'Backend Engineer', company_name: 'QA Demo Co' } })).body;
  await c.post(`/api/hr/batches/${batch.id}/questions/defaults`, { token });
  await c.post(`/api/hr/batches/${batch.id}/candidates`, { token, json: { candidates: list } });
  return batch;
}

/** What the browser does on /join: swap the token for a sign-in link. */
const join = (token) => c.post('/api/auth/join', { json: { token } });

// ── Sending ──

test('running a campaign emails every candidate once, each with their own personal link', async () => {
  const batch = await campaign();
  assert.equal(mail.sent.length, 0, 'nothing is sent while the campaign is a draft');
  const run = await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  assert.equal(run.status, 200);
  assert.equal(run.body.status, 'live');
  assert.deepEqual(run.body.emails, { configured: true, queued: 3 });
  await settle();

  assert.deepEqual(mail.sent.map(m => m.to).sort(), ['p1@qa.test', 'p2@qa.test', 'p3@qa.test']);
  const links = mail.sent.map(m => m.link);
  assert.equal(new Set(links).size, 3, 'every candidate gets a different link');
  for (const m of mail.sent) {
    assert.match(m.link, /^http:\/\/qa\.localhost\/join\?t=/, 'link points at the app (PUBLIC_APP_URL)');
    assert.match(m.subject, /Backend Engineer at QA Demo Co/);
    assert.match(m.html, /Start my screening/);
    const cand = store.candidates.find(x => x.email === m.to);
    assert.equal((await import('../../../backend/src/services/inviteToken.js')).verifyInviteToken(tokenOf(m.link)).candidateId, cand.id, 'the link names exactly this candidate');
    assert.ok(cand.invite_email_sent_at);
  }
  const detail = await c.get(`/api/hr/batches/${batch.id}`, { token: admin });
  assert.equal(detail.body.email.configured, true);
  assert.ok(detail.body.candidates.every(x => x.invite_email_sent_at && !x.invite_email_error));
});

test('running again, or reopening a closed campaign, does not email people twice', async () => {
  const batch = await campaign();
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  const again = await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  assert.equal(again.body.emails.queued, 0);
  await c.post(`/api/hr/batches/${batch.id}/close`, { token: admin });
  const reopen = await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  assert.equal(reopen.body.emails.queued, 0);
  await settle();
  assert.equal(mail.sent.length, 3);
});

test('people added to a live campaign are emailed straight away; added to a draft, they wait for Run', async () => {
  const batch = await campaign(admin, people(1));
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  const add = await c.post(`/api/hr/batches/${batch.id}/candidates`, { token: admin, json: { candidates: [{ name: 'Late Joiner', email: 'late@qa.test' }, { name: 'Dup', email: 'p1@qa.test' }] } });
  assert.deepEqual(add.body.emails, { configured: true, queued: 1 });
  await settle();
  assert.deepEqual(mail.sent.map(m => m.to), ['p1@qa.test', 'late@qa.test']);

  const draft = await campaign(admin, []);
  const addDraft = await c.post(`/api/hr/batches/${draft.id}/candidates`, { token: admin, json: { candidates: [{ name: 'D', email: 'd@qa.test' }] } });
  assert.equal(addDraft.body.emails.queued, 0);
});

test('without SMTP settings the campaign still runs; HR is told emails are not set up', async () => {
  useTestTransport(null);
  const batch = await campaign();
  const run = await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.emails, { configured: false, queued: 0 });
  assert.equal((await c.get(`/api/hr/batches/${batch.id}`, { token: admin })).body.email.configured, false);
  const resend = await c.post(`/api/hr/candidates/${store.candidates[0].id}/send-invite`, { token: admin });
  assert.equal(resend.status, 503);
});

test('one address that bounces is recorded as failed; everyone else still gets their email', async () => {
  mail = installFakeMail({ fail: (m) => (m.to === 'p2@qa.test' ? new Error('550 5.1.1 The email account that you tried to reach does not exist') : null) });
  const batch = await campaign();
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  assert.deepEqual(mail.sent.map(m => m.to).sort(), ['p1@qa.test', 'p3@qa.test']);
  const rows = (await c.get(`/api/hr/batches/${batch.id}`, { token: admin })).body.candidates;
  const bad = rows.find(r => r.email === 'p2@qa.test');
  assert.equal(bad.invite_email_sent_at, null);
  assert.match(bad.invite_email_error, /550/);
});

test('HR and Admin email addresses never get a candidate invite', async () => {
  store.addProfile({ id: 'rec-x', email: 'recx@qa.test', role: 'recruiter' });
  const batch = await campaign(admin, [{ name: 'Sneaky', email: 'recx@qa.test' }, { name: 'Real', email: 'real@qa.test' }]);
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  assert.deepEqual(mail.sent.map(m => m.to), ['real@qa.test']);
  assert.match(store.candidates.find(x => x.email === 'recx@qa.test').invite_email_error, /HR account/);
});

// ── Resend ──

test('HR can send the email again; not before Run, not after the candidate finished, not for other recruiters', async () => {
  const batch = await campaign(recA);
  const cand = store.candidates[0];
  assert.equal((await c.post(`/api/hr/candidates/${cand.id}/send-invite`, { token: recA })).status, 409, 'draft');
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: recA });
  await settle();
  const r = await c.post(`/api/hr/candidates/${cand.id}/send-invite`, { token: recA });
  assert.equal(r.status, 200);
  assert.equal(mail.sent.filter(m => m.to === cand.email).length, 2);
  assert.equal((await c.post(`/api/hr/candidates/${cand.id}/send-invite`, { token: recB })).status, 404, 'other recruiter');
  assert.equal((await c.post(`/api/hr/candidates/${cand.id}/send-invite`, { token: tokens.candidate('u', cand.email) })).status, 403, 'candidate');
  store.candidates[0].status = 'completed';
  assert.equal((await c.post(`/api/hr/candidates/${cand.id}/send-invite`, { token: recA })).status, 409, 'finished');
});

test('a failed resend answers 502 with the reason and keeps it on the row', async () => {
  const batch = await campaign(admin, people(1));
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  installFakeMail({ fail: () => Object.assign(new Error('535 bad login'), { code: 'EAUTH' }) });
  const r = await c.post(`/api/hr/candidates/${store.candidates[0].id}/send-invite`, { token: admin });
  assert.equal(r.status, 502);
  assert.match(r.body.message, /App Password/);
  assert.match(store.candidates[0].invite_email_error, /App Password/);
});

// ── Opening the link ──

test('the emailed link signs the candidate in on the server (no Supabase address); then the full call works', async () => {
  const batch = await campaign(admin, [{ name: 'Asha Rao', email: 'asha@qa.test' }]);
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  const link = mail.linkFor('asha@qa.test');
  assert.match(link, /^http:\/\/qa\.localhost\/join\?t=/, 'the email names only the app address');
  const r = await join(tokenOf(link));
  assert.equal(r.status, 200);
  assert.equal(r.body.redirect_url, undefined, 'the browser is not sent to Supabase');
  assert.doesNotMatch(JSON.stringify(r.body), /supabase|auth\/v1/i);
  assert.equal(r.body.user.email, 'asha@qa.test');

  const cand = store.candidates[0];
  const authUser = store.authUsers.find(u => u.email === 'asha@qa.test');
  assert.equal(cand.user_id, authUser.id, 'the screening is linked to the account the link signs into');
  assert.equal(r.body.user.id, authUser.id);
  const last = await takeCall(c, r.body.token);
  assert.equal(last.body.outcome, 'completed');
});

test('the emailed link can be opened again later (each visit makes a fresh session from a one-time link)', async () => {
  const batch = await campaign(admin, people(1));
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  const t = tokenOf(mail.sent[0].link);
  const a = await join(t);
  const b = await join(t);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.ok(a.body.token && b.body.token);
  assert.equal(store.linkTokens.size, 0, 'every one-time link was used up on the server');
});

test('broken, edited, expired or missing tokens get a clear error and no sign-in', async () => {
  const batch = await campaign(admin, people(1));
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  const t = tokenOf(mail.sent[0].link);
  assert.equal((await join(t.slice(0, -3) + 'abc')).status, 400);
  assert.equal((await join('')).status, 400);
  assert.equal((await c.post('/api/auth/join', { json: {} })).status, 400);
  assert.equal((await c.post('/api/auth/join', { json: { token: { $ne: null } } })).status, 400);
  const old = createInviteToken(store.candidates[0].id, store.candidates[0].email, { now: Date.now() - 40 * 24 * 3600e3, days: 30 }).token;
  const expired = await join(old);
  assert.equal(expired.status, 410);
  assert.match(expired.body.message, /expired/);
  assert.equal(store.authUsers.length, 0, 'no account was created by any of these');
});

test('the link stops working when the campaign is closed or the candidate is removed', async () => {
  const batch = await campaign(admin, people(2));
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  const [first, second] = mail.sent.map(m => tokenOf(m.link));
  await c.post(`/api/hr/batches/${batch.id}/close`, { token: admin });
  const closed = await join(first);
  assert.equal(closed.status, 409);
  assert.match(closed.body.message, /closed/);
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  const removedId = verifyId(second);
  await c.del(`/api/hr/candidates/${removedId}`, { token: admin });
  assert.equal((await join(second)).status, 404);
});

function verifyId(t) { return JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()).c; }

test('a link for an email that became an HR account is refused at sign-in too', async () => {
  const batch = await campaign(admin, [{ name: 'Later HR', email: 'later@qa.test' }]);
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  store.addProfile({ id: 'rec-later', email: 'later@qa.test', role: 'recruiter' });
  const r = await join(tokenOf(mail.sent[0].link));
  assert.equal(r.status, 409);
});

test('nothing in the email flow calls a real outside service', async () => {
  const batch = await campaign(admin, people(2));
  await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
  await settle();
  await join(tokenOf(mail.sent[0].link));
  assert.deepEqual(net.refused, []);
});

// ── Brevo (email over HTTPS, for hosts that block SMTP such as Render's free plan) ──

/** Runs fn with BREVO_API_KEY set and a fake Brevo API; `fail(to)` → HTTP status to answer instead of 201. */
async function withFakeBrevo(fail, fn) {
  const calls = [];
  const saved = { BREVO_API_KEY: process.env.BREVO_API_KEY, MAIL_FROM: process.env.MAIL_FROM, MAIL_REPLY_TO: process.env.MAIL_REPLY_TO };
  Object.assign(process.env, { BREVO_API_KEY: 'qa-brevo-key', MAIL_FROM: 'HR Screening <hr@qa.test>', MAIL_REPLY_TO: 'hr@qa.test' });
  useTestTransport(null);
  useTestFetch(async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, key: init.headers['api-key'], body });
    const status = fail?.(body.to[0].email);
    return status
      ? new Response(JSON.stringify({ code: 'unauthorized', message: 'Key not found' }), { status })
      : new Response(JSON.stringify({ messageId: `<brevo-${calls.length}@qa>` }), { status: 201 });
  });
  try { return await fn(calls); } finally { useTestFetch(null); Object.assign(process.env, saved); }
}

const linkIn = (text) => String(text).match(/https?:\/\/\S+\/join\?t=\S+/)?.[0];

test('Brevo: running a campaign emails every candidate through the Brevo API, and the links sign them in', async () => {
  await withFakeBrevo(null, async (calls) => {
    const batch = await campaign();
    const run = await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
    assert.deepEqual(run.body.emails, { configured: true, queued: 3 });
    await settle();

    assert.equal(calls.length, 3);
    assert.ok(calls.every(x => x.url === 'https://api.brevo.com/v3/smtp/email' && x.key === 'qa-brevo-key'));
    assert.deepEqual(calls.map(x => x.body.to[0].email).sort(), ['p1@qa.test', 'p2@qa.test', 'p3@qa.test']);
    for (const { body } of calls) {
      assert.deepEqual(body.sender, { name: 'HR Screening', email: 'hr@qa.test' });
      assert.deepEqual(body.replyTo, { email: 'hr@qa.test' });
      assert.match(body.subject, /Backend Engineer at QA Demo Co/);
      assert.match(body.htmlContent, /Start my screening/);
      const link = linkIn(body.textContent);
      assert.match(link, /^http:\/\/qa\.localhost\/join\?t=/, 'the text body carries the personal link');
      assert.ok(body.htmlContent.includes(tokenOf(link)), 'the button carries the same link');
    }
    assert.ok(store.candidates.every(x => x.invite_email_sent_at && !x.invite_email_error));

    const joined = await join(tokenOf(linkIn(calls[0].body.textContent)));
    assert.equal(joined.status, 200, 'the emailed link signs the candidate in');
  });
});

test('Brevo: a refused key is recorded on the candidate in plain words and resending reports it', async () => {
  await withFakeBrevo((to) => (to === 'p2@qa.test' ? 401 : null), async (calls) => {
    const batch = await campaign();
    await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
    await settle();
    const bad = store.candidates.find(x => x.email === 'p2@qa.test');
    assert.match(bad.invite_email_error, /BREVO_API_KEY/);
    assert.ok(!bad.invite_email_sent_at);
    assert.equal(store.candidates.filter(x => x.invite_email_sent_at).length, 2, 'the others still get their email');

    const again = await c.post(`/api/hr/candidates/${bad.id}/send-invite`, { token: admin });
    assert.equal(again.status, 502);
    assert.match(again.body.message, /verified sender/);
    assert.equal(calls.length, 4);
  });
});

test('Brevo: with MAIL_FROM missing the app says exactly what to add', async () => {
  await withFakeBrevo(null, async (calls) => {
    process.env.MAIL_FROM = '';
    const batch = await campaign();
    const cand = store.candidates[0];
    await c.post(`/api/hr/batches/${batch.id}/run`, { token: admin });
    const res = await c.post(`/api/hr/candidates/${cand.id}/send-invite`, { token: admin });
    assert.equal(res.status, 503);
    assert.match(res.body.message, /MAIL_FROM/);
    assert.equal(calls.length, 0);
  });
});
