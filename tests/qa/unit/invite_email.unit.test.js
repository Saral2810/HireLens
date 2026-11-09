// Unit (TDD): signed invite tokens, the invite email, the SMTP mailer and the background email queue.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInviteToken, verifyInviteToken, emailTag, InviteTokenError, inviteLinkDays } from '../../../backend/src/services/inviteToken.js';
import { buildInviteEmail } from '../../../backend/src/services/inviteEmail.js';
import { sendMail, isMailConfigured, MailError, useTestTransport, useTestFetch, mailProvider, missingMailSettings } from '../../../backend/src/services/mailer.js';
import { queueInviteEmails } from '../../../backend/src/services/candidateInvites.js';
import { installFakeDb } from '../helpers/fakeDb.js';
import { installFakeMail } from '../helpers/mail.js';

const ID = '11111111-2222-4333-8444-555555555555';
const EMAIL = 'asha@qa.test';
const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try { return await fn(); } finally { Object.assign(process.env, saved); }
};

afterEach(() => useTestTransport(null));

// ── Tokens ──

test('token round trip: names the candidate and the expiry', () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  const { token, expiresAt } = createInviteToken(ID, EMAIL, { now, days: 30 });
  assert.equal(expiresAt.toISOString(), '2026-12-01T10:00:00.000Z');
  assert.match(token, /^[\w-]+\.[\w-]+$/, 'URL-safe, two parts');
  const v = verifyInviteToken(token, { now });
  assert.equal(v.candidateId, ID);
  assert.equal(v.emailTag, emailTag(' ASHA@qa.test '), 'tag ignores case and spaces');
  assert.notEqual(v.emailTag, emailTag('other@qa.test'));
  assert.doesNotMatch(Buffer.from(token.split('.')[0], 'base64url').toString(), /asha/, 'the address itself is not in the link');
});

test('a changed token is refused (other candidate id, or edited signature)', () => {
  const { token } = createInviteToken(ID, EMAIL);
  const [body, sig] = token.split('.');
  const other = Buffer.from(JSON.stringify({ c: 'aaaaaaaa-2222-4333-8444-555555555555', m: emailTag(EMAIL), e: 4102444800 })).toString('base64url');
  for (const bad of [`${other}.${sig}`, `${body}.${sig.slice(0, -2)}xx`, `${body}.`, body, `${token}.x`, '', 'a'.repeat(600), null, 42, { token }]) {
    assert.throws(() => verifyInviteToken(bad), (e) => e instanceof InviteTokenError && e.reason === 'invalid', String(bad).slice(0, 40));
  }
});

test('a token signed with a different secret is refused', async () => {
  const { token } = await withEnv({ INVITE_SECRET: 'another-secret-another-secret-another-secret' }, () => createInviteToken(ID, EMAIL));
  assert.throws(() => verifyInviteToken(token), (e) => e.reason === 'invalid');
});

test('expired tokens are refused with reason "expired"', () => {
  const now = Date.parse('2026-11-01T10:00:00Z');
  const { token } = createInviteToken(ID, EMAIL, { now, days: 1 });
  assert.doesNotThrow(() => verifyInviteToken(token, { now: now + 23 * 3600e3 }));
  assert.throws(() => verifyInviteToken(token, { now: now + 25 * 3600e3 }), (e) => e.reason === 'expired');
});

test('without INVITE_SECRET the key is derived from the Supabase service key; with neither, links cannot be made', async () => {
  await withEnv({ INVITE_SECRET: '', SUPABASE_SERVICE_ROLE_KEY: 'service-key-for-test' }, () => {
    assert.equal(verifyInviteToken(createInviteToken(ID, EMAIL).token).candidateId, ID);
  });
  await withEnv({ INVITE_SECRET: 'too-short', SUPABASE_SERVICE_ROLE_KEY: '', SUPABASE_SECRET_KEY: '' }, () => {
    assert.throws(() => createInviteToken(ID, EMAIL), (e) => e.reason === 'not_configured');
  });
});

test('link lifetime: default 30 days, capped at 90, bad values fall back to 30', async () => {
  assert.equal(inviteLinkDays(), 30);
  await withEnv({ INVITE_LINK_DAYS: '365' }, () => assert.equal(inviteLinkDays(), 90));
  await withEnv({ INVITE_LINK_DAYS: 'abc' }, () => assert.equal(inviteLinkDays(), 30));
});

// ── Email content ──

const email = (over = {}) => buildInviteEmail({
  candidateName: 'Asha Rao', jobRole: 'Backend Engineer', companyName: 'Demo Co',
  link: 'https://app.example/join?t=abc.def', expiresAt: new Date('2026-12-01T10:00:00Z'), senderName: 'Saral (Hiring)', ...over
});

test('email names the role, company, first name, the personal link and when it expires', () => {
  const e = email();
  assert.equal(e.subject, 'Your screening for Backend Engineer at Demo Co: start here');
  assert.match(e.text, /^Hi Asha,/);
  assert.match(e.text, /https:\/\/app\.example\/join\?t=abc\.def/);
  assert.match(e.text, /1 December 2026/);
  assert.match(e.text, /Saral \(Hiring\)$/);
  assert.match(e.html, /href="https:\/\/app\.example\/join\?t=abc\.def"/);
  assert.match(e.html, /Start my screening/);
});

test('names and roles from HR spreadsheets cannot inject HTML or extra email headers', () => {
  const e = email({ candidateName: '<img src=x onerror=alert(1)> Evil', jobRole: 'SDE\r\nBcc: victim@x.co', companyName: '"Acme" & <b>Co</b>' });
  assert.doesNotMatch(e.html, /<img src=x/);
  assert.match(e.html, /&lt;img/);
  assert.match(e.html, /&quot;Acme&quot; &amp; &lt;b&gt;Co&lt;\/b&gt;/);
  assert.doesNotMatch(e.subject, /[\r\n]/);
});

test('email still reads well without a company or sender name', () => {
  const e = email({ companyName: null, senderName: null, candidateName: '' });
  assert.equal(e.subject, 'Your screening for Backend Engineer: start here');
  assert.match(e.text, /^Hi there,/);
  assert.match(e.text, /The Hiring Team$/);
});

// ── Mailer ──

test('mailer: not configured without SMTP settings; never sends for real under tests', async () => {
  assert.equal(isMailConfigured(), false);
  await assert.rejects(sendMail({ to: 'a@x.co', subject: 's', text: 't', html: 'h' }), MailError);
  await withEnv({ SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'me@gmail.com', SMTP_PASS: 'x', MAIL_FROM: 'me@gmail.com' }, async () => {
    assert.equal(isMailConfigured(), true);
    await assert.rejects(sendMail({ to: 'a@x.co', subject: 's', text: 't', html: 'h' }), /disabled while tests run/);
  });
});

test('mailer: a refused login is explained in plain words (Gmail App Password)', async () => {
  installFakeMail({ fail: () => Object.assign(new Error('535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 }) });
  await assert.rejects(sendMail({ to: 'a@x.co', subject: 's', text: 't', html: 'h' }), /App Password/);
});

test('mailer: other server errors are shortened, not passed through whole', async () => {
  installFakeMail({ fail: () => new Error(`421 Try again later ${'x'.repeat(500)}`) });
  await assert.rejects(sendMail({ to: 'a@x.co', subject: 's', text: 't', html: 'h' }), (e) => e.message.length < 260 && /421/.test(e.message));
});

// Email APIs: under tests the mailer sends only through a fake fetch (useTestFetch).
const withFakeFetch = async (reply, fn) => {
  const calls = [];
  useTestFetch(async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  try { await fn(calls); } finally { useTestFetch(null); }
};
const MSG = { to: 'asha@qa.test', subject: 'Invite', text: 't', html: '<p>h</p>' };

test('mailer: provider is smtp by default, the API whose key is set, or MAIL_PROVIDER', async () => {
  assert.equal(mailProvider(), 'smtp');
  await withEnv({ BREVO_API_KEY: 'k' }, () => assert.equal(mailProvider(), 'brevo'));
  await withEnv({ RESEND_API_KEY: 'k' }, () => assert.equal(mailProvider(), 'resend'));
  await withEnv({ BREVO_API_KEY: 'k', MAIL_PROVIDER: 'smtp' }, () => assert.equal(mailProvider(), 'smtp'));
  await withEnv({ BREVO_API_KEY: '' }, () => assert.deepEqual(missingMailSettings(), ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM']));
  await withEnv({ MAIL_PROVIDER: 'brevo', MAIL_FROM: 'me@gmail.com' }, () => {
    assert.deepEqual(missingMailSettings(), ['BREVO_API_KEY']);
    assert.equal(isMailConfigured(), false);
  });
});

test('mailer: Brevo gets the sender name, address, reply-to and both bodies over HTTPS', async () => {
  await withEnv({ BREVO_API_KEY: 'brevo-key', MAIL_FROM: '"Saral (Hiring)" <me@gmail.com>', MAIL_REPLY_TO: 'hr@gmail.com' }, () =>
    withFakeFetch({ status: 201, body: { messageId: '<b-1@brevo>' } }, async (calls) => {
      assert.deepEqual(await sendMail(MSG), { messageId: '<b-1@brevo>' });
      assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
      assert.equal(calls[0].headers['api-key'], 'brevo-key');
      assert.deepEqual(calls[0].body, {
        sender: { name: 'Saral (Hiring)', email: 'me@gmail.com' }, to: [{ email: 'asha@qa.test' }], subject: 'Invite',
        textContent: 't', htmlContent: '<p>h</p>', replyTo: { email: 'hr@gmail.com' }
      });
    }));
});

test('mailer: Resend gets the From line as written', async () => {
  await withEnv({ RESEND_API_KEY: 'resend-key', MAIL_FROM: 'Hiring <jobs@acme.in>', MAIL_REPLY_TO: '' }, () =>
    withFakeFetch({ status: 200, body: { id: 'r-1' } }, async (calls) => {
      assert.deepEqual(await sendMail(MSG), { messageId: 'r-1' });
      assert.equal(calls[0].url, 'https://api.resend.com/emails');
      assert.equal(calls[0].headers.Authorization, 'Bearer resend-key');
      assert.deepEqual(calls[0].body, { from: 'Hiring <jobs@acme.in>', to: ['asha@qa.test'], subject: 'Invite', text: 't', html: '<p>h</p>' });
    }));
});

test('mailer: a refused API key or unverified sender is explained in plain words', async () => {
  await withEnv({ BREVO_API_KEY: 'bad', MAIL_FROM: 'me@gmail.com' }, () =>
    withFakeFetch({ status: 401, body: { code: 'unauthorized', message: 'Key not found' } }, () =>
      assert.rejects(sendMail(MSG), (e) => e instanceof MailError && /BREVO_API_KEY/.test(e.message) && /verified sender/.test(e.message))));
  await withEnv({ BREVO_API_KEY: 'k', MAIL_FROM: 'me@gmail.com' }, () =>
    withFakeFetch({ status: 400, body: { code: 'invalid_parameter', message: 'email is not valid' } }, () =>
      assert.rejects(sendMail(MSG), /brevo answered 400: email is not valid/)));
});

test('mailer: an email API key alone still sends nothing under tests without a fake fetch', async () => {
  await withEnv({ BREVO_API_KEY: 'k', MAIL_FROM: 'me@gmail.com' }, () =>
    assert.rejects(sendMail(MSG), /disabled while tests run/));
});

test('mailer: an SMTP connection timeout points at the email API', async () => {
  installFakeMail({ fail: () => Object.assign(new Error('Connection timeout'), { code: 'ETIMEDOUT' }) });
  await assert.rejects(sendMail(MSG), /BREVO_API_KEY/);
});

// ── Background queue ──

test('queue: emails only people not yet emailed and not finished, at most 2 at a time, and records each result', async () => {
  const store = installFakeDb();
  const mail = installFakeMail({ latencyMs: 15, fail: (m) => (m.to === 'bad@qa.test' ? new Error('550 mailbox unavailable') : null) });
  const batch = await (await import('../../../backend/src/config/db.js')).default.createBatch({ name: 'B', job_role: 'SDE', created_by: 'a', status: 'live', workspace_id: '00000000-0000-0000-0000-000000000001' });
  const db = (await import('../../../backend/src/config/db.js')).default;
  await db.addCandidates(batch.id, [1, 2, 3, 4, 5].map(i => ({ name: `P${i}`, email: `p${i}@qa.test` })).concat({ name: 'Bad', email: 'bad@qa.test' }));
  store.candidates[0].invite_email_sent_at = '2026-11-01T09:00:00Z';
  store.candidates[1].status = 'completed';
  const job = queueInviteEmails(batch, await db.listCandidates(batch.id), 'https://app.example');
  assert.deepEqual([job.configured, job.queued], [true, 4]);
  assert.deepEqual(await job.done, { sent: 3, failed: 1 });
  assert.equal(mail.maxActive, 2);
  assert.deepEqual(mail.sent.map(m => m.to).sort(), ['p3@qa.test', 'p4@qa.test', 'p5@qa.test']);
  assert.match(store.candidates.find(c => c.email === 'bad@qa.test').invite_email_error, /550/);
  assert.ok(store.candidates.find(c => c.email === 'p3@qa.test').invite_email_sent_at);
});

test('queue: does nothing when email is not set up', async () => {
  installFakeDb();
  const job = queueInviteEmails({ id: 'b' }, [{ id: 'c', email: 'a@x.co', status: 'invited' }], 'https://app.example');
  assert.deepEqual([job.configured, job.queued], [false, 0]);
});
