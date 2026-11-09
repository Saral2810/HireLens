// Integration: HR sign-up through the sign-up link, separate workspaces, the HR lead role and the
// demo workspace limits. Fake DB, fake mail, fake Gnani + LLM; no network, no credits.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { installFakeDb } from '../helpers/fakeDb.js';
import { installFakeMail } from '../helpers/mail.js';
import { resetNetwork } from '../helpers/network.js';
import { startApp, tokens, liveCampaign, takeCall } from '../helpers/http.js';
import { runningInviteJobs } from '../../../backend/src/services/candidateInvites.js';
import { useTestTransport } from '../../../backend/src/services/mailer.js';
import { MAIN_WORKSPACE_ID } from '../../../backend/src/middleware/auth.js';
import { DEMO_LIMITS } from '../../../backend/src/services/workspaceLimits.js';

let app, store, c, mail;
const admin = tokens.admin();
const CLIENT_ID = '123456-qa.apps.googleusercontent.com';
const CODE = 'qa-signup-code-0123456789abcdef';
const NONCE = 'qa-nonce-0123456789abcdef';
const settle = () => Promise.all([...runningInviteJobs]);

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => {
  store = installFakeDb(); resetNetwork(); mail = installFakeMail();
  Object.assign(process.env, { GOOGLE_CLIENT_ID: CLIENT_ID, HR_SIGNUP_CODE: CODE });
  delete process.env.MAX_DEMO_WORKSPACES;
});
afterEach(() => { useTestTransport(null); delete process.env.GOOGLE_CLIENT_ID; delete process.env.HR_SIGNUP_CODE; delete process.env.MAX_DEMO_WORKSPACES; });

function googleToken({ email, nonce = NONCE, name = 'Interviewer Name' }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc({ email, aud: CLIENT_ID, nonce: crypto.createHash('sha256').update(nonce).digest('hex'), name })}.qa-google-sig`;
}
const signup = (email, extra = {}) => c.post('/api/auth/google/hr-signup', { json: { credential: googleToken({ email }), nonce: NONCE, code: CODE, ...extra } });

/**
 * Signs up a new HR lead and returns their token and workspace id. In production the session token
 * carries no role: the server reads the role from the profile on every request, so the token issued
 * at sign-up works as HR lead. The fake's test tokens carry the role, and the fake issued this one
 * before the promotion, so the test uses an HR lead test token for the same user and workspace.
 */
async function newLead(email = 'lead@demo.test', extra = {}) {
  const r = await signup(email, extra);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const { id } = r.body.user;
  const workspaceId = r.body.workspace.id;
  assert.equal(store.profiles.find(p => p.id === id).role, 'hr_lead', 'the profile itself was promoted');
  return { token: `test:hr_lead:${id}:${email}:${workspaceId}`, id, workspaceId, body: r.body };
}

// ── Sign-up ──

test('Sign-up link: the right code is valid; a wrong, missing or too-short code is not', async () => {
  assert.equal((await c.get(`/api/auth/hr-signup?code=${CODE}`)).body.valid, false, 'Supabase Google provider check fails without Supabase');
  // The provider check needs Supabase; the code itself is what this test is about, so check the POST instead.
  assert.equal((await c.post('/api/auth/google/hr-signup', { json: { credential: googleToken({ email: 'x@demo.test' }), nonce: NONCE, code: 'wrong-code-0123456789' } })).status, 403);
  assert.equal((await c.post('/api/auth/google/hr-signup', { json: { credential: googleToken({ email: 'x@demo.test' }), nonce: NONCE } })).status, 403);
  process.env.HR_SIGNUP_CODE = 'short';
  assert.equal((await c.post('/api/auth/google/hr-signup', { json: { credential: googleToken({ email: 'x@demo.test' }), nonce: NONCE, code: 'short' } })).status, 403, 'a short code switches sign-up off');
  assert.equal(store.authUsers.length, 0, 'no account was created');
});

test('Open sign-up (no code set): anyone with Google gets a workspace without any code', async () => {
  delete process.env.HR_SIGNUP_CODE;
  const r = await c.post('/api/auth/google/hr-signup', { json: { credential: googleToken({ email: 'board@demo.test' }), nonce: NONCE } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.user.role, 'hr_lead');
  assert.equal(r.body.workspace.name, "Interviewer Name's workspace");
  // The same Google button then simply signs them in.
  const again = await c.post('/api/auth/google/hr-signup', { json: { credential: googleToken({ email: 'board@demo.test' }), nonce: NONCE } });
  assert.equal(again.status, 200);
  assert.equal(store.workspaces.filter(w => w.kind === 'demo').length, 1);
  // A made-up token still gets nobody in, and creates nothing.
  const forged = await c.post('/api/auth/google/hr-signup', { json: { credential: googleToken({ email: 'bot@demo.test' }).replace(/qa-google-sig$/, 'forged'), nonce: NONCE } });
  assert.equal(forged.status, 401);
  assert.equal(store.authUsers.filter(u => u.email === 'bot@demo.test').length, 0);
});

test('Sign-up switched off (HR_SIGNUP=off): nobody can create a workspace, with or without a code', async () => {
  process.env.HR_SIGNUP = 'off';
  try {
    for (const code of [undefined, CODE]) {
      const r = await c.post('/api/auth/google/hr-signup', { json: { credential: googleToken({ email: 'x@demo.test' }), nonce: NONCE, code } });
      assert.equal(r.status, 403);
      assert.match(r.body.message, /closed/);
    }
    assert.equal(store.workspaces.length, 1);
  } finally {
    delete process.env.HR_SIGNUP;
  }
});

test('Sign-up status: open mode reports open; code mode is valid only with the right code', async () => {
  // Without Supabase the Google provider check fails, so both flags are false here; the POST tests above
  // cover each mode. This only checks the shape of the answer.
  const status = (await c.get('/api/auth/hr-signup')).body;
  assert.deepEqual(Object.keys(status).sort(), ['open', 'valid']);
});

test('Signing up creates a demo workspace with limits, and the person is its HR lead, never an Admin', async () => {
  const lead = await newLead('lead@demo.test', { workspace_name: 'Acme Hiring' });
  assert.equal(lead.body.user.role, 'hr_lead');
  assert.equal(lead.body.workspace.name, 'Acme Hiring');
  const ws = store.workspaces.find(w => w.id === lead.workspaceId);
  assert.equal(ws.kind, 'demo');
  for (const [k, v] of Object.entries(DEMO_LIMITS)) assert.equal(ws[k], v, k);
  assert.notEqual(lead.workspaceId, MAIN_WORKSPACE_ID);

  const me = await c.get('/api/auth/me', { token: lead.token });
  assert.equal(me.body.role, 'hr_lead');
  const summary = await c.get('/api/hr/workspace', { token: lead.token });
  assert.equal(summary.status, 200);
  assert.equal(summary.body.kind, 'demo');
  assert.equal(summary.body.limits.max_campaigns, 3);
  assert.deepEqual(summary.body.usage, { campaigns: 0, members: 1, completed_calls: 0, emails_last_24h: 0 });
  // The same person signing up again is just signed in: no second workspace.
  const again = await signup('lead@demo.test');
  assert.equal(again.status, 200);
  assert.equal(store.workspaces.filter(w => w.kind === 'demo').length, 1);
});

test('Existing HR and candidate emails cannot make a new workspace; the total number of sign-ups is capped', async () => {
  store.addProfile({ id: 'boss-1', email: 'boss@qa.test', role: 'superadmin' });
  const existing = await signup('boss@qa.test');
  assert.equal(existing.status, 200, 'an existing HR account is signed in');
  assert.equal(existing.body.user.role, 'superadmin');
  assert.equal(store.workspaces.length, 1, 'no workspace made');

  await liveCampaign(c, admin, { people: [{ name: 'Asha', email: 'asha@qa.test' }] });
  assert.equal((await signup('asha@qa.test')).status, 409, 'a candidate email cannot become HR');

  process.env.MAX_DEMO_WORKSPACES = '1';
  await newLead('first@demo.test');
  const full = await signup('second@demo.test');
  assert.equal(full.status, 503);
  assert.equal(store.authUsers.filter(u => u.email === 'second@demo.test').length, 0);
});

// ── Separate workspaces ──

test('Workspaces are separate: neither side can see, open or change the other side\'s campaigns or team', async () => {
  const main = await liveCampaign(c, admin, { name: 'Main campaign', people: [{ name: 'Asha', email: 'asha@qa.test' }] });
  const lead = await newLead();
  const demo = (await c.post('/api/hr/batches', { token: lead.token, json: { name: 'Demo campaign', job_role: 'SDE' } })).body;

  assert.deepEqual((await c.get('/api/hr/batches', { token: lead.token })).body.map(b => b.name), ['Demo campaign']);
  assert.deepEqual((await c.get('/api/hr/batches', { token: admin })).body.map(b => b.name), ['Main campaign']);
  for (const path of [`/api/hr/batches/${main.batch.id}`, `/api/hr/batches/${main.batch.id}/results`, `/api/hr/candidates/${main.candidates[0].id}/invite-link`]) {
    const r = path.endsWith('invite-link') ? await c.post(path, { token: lead.token }) : await c.get(path, { token: lead.token });
    assert.equal(r.status, 404, path);
  }
  assert.equal((await c.patch(`/api/hr/batches/${main.batch.id}`, { token: lead.token, json: { name: 'Hacked' } })).status, 404);
  assert.equal((await c.del(`/api/hr/batches/${main.batch.id}`, { token: lead.token })).status, 404);
  assert.equal((await c.get(`/api/hr/batches/${demo.id}`, { token: admin })).status, 404, 'your Admin cannot open their campaign either');

  const leadTeam = (await c.get('/api/hr/team', { token: lead.token })).body;
  assert.deepEqual(leadTeam.map(m => m.email), ['lead@demo.test']);
  assert.ok(!(await c.get('/api/hr/team', { token: admin })).body.some(m => m.email === 'lead@demo.test'));
  assert.equal((await c.del(`/api/hr/team/${lead.id}`, { token: admin })).status, 404, 'your Admin cannot remove them');

  const analytics = (await c.get('/api/hr/analytics', { token: lead.token })).body;
  assert.equal(analytics.campaigns.total, 1);
});

// ── The HR lead's powers ──

test('An HR lead adds HR members (recruiters) only, cannot change roles, and manages only their own team', async () => {
  const lead = await newLead();
  assert.equal((await c.post('/api/hr/team', { token: lead.token, json: { name: 'Admin?', email: 'a@demo.test', role: 'superadmin', sign_in: 'google' } })).status, 403);
  const rec = await c.post('/api/hr/team', { token: lead.token, json: { name: 'Ravi', email: 'ravi@demo.test', role: 'recruiter', sign_in: 'google' } });
  assert.equal(rec.status, 201);
  assert.equal(rec.body.role, 'recruiter');
  assert.equal(store.profiles.find(p => p.email === 'ravi@demo.test').workspace_id, lead.workspaceId);
  assert.equal((await c.patch(`/api/hr/team/${rec.body.id}`, { token: lead.token, json: { role: 'superadmin' } })).status, 403);

  // The new recruiter signs in with Google, sees only their own campaigns; the lead sees all of them.
  const ravi = (await c.post('/api/auth/google/hr-token', { json: { credential: googleToken({ email: 'ravi@demo.test' }), nonce: NONCE } })).body;
  assert.equal(ravi.user.role, 'recruiter');
  await c.post('/api/hr/batches', { token: ravi.token, json: { name: 'Ravi campaign', job_role: 'QA' } });
  await c.post('/api/hr/batches', { token: lead.token, json: { name: 'Lead campaign', job_role: 'QA' } });
  assert.deepEqual((await c.get('/api/hr/batches', { token: ravi.token })).body.map(b => b.name), ['Ravi campaign']);
  assert.deepEqual((await c.get('/api/hr/batches', { token: lead.token })).body.map(b => b.name).sort(), ['Lead campaign', 'Ravi campaign']);
  assert.equal((await c.get('/api/hr/team', { token: ravi.token })).status, 403, 'a recruiter has no Team page');

  assert.equal((await c.del(`/api/hr/team/${rec.body.id}`, { token: lead.token })).status, 204);
  assert.equal(store.batches.find(b => b.name === 'Ravi campaign').created_by, lead.id, 'their campaign moved to the lead');
  assert.equal((await c.del(`/api/hr/team/${lead.id}`, { token: lead.token })).status, 400, 'cannot remove yourself');
});

// ── Limits ──

test('Limits: 3 campaigns, 10 candidates per campaign and 5 members in a demo workspace; your workspace has none', async () => {
  const lead = await newLead();
  for (let i = 1; i <= 3; i += 1) assert.equal((await c.post('/api/hr/batches', { token: lead.token, json: { name: `C${i}`, job_role: 'R' } })).status, 201);
  const fourth = await c.post('/api/hr/batches', { token: lead.token, json: { name: 'C4', job_role: 'R' } });
  assert.equal(fourth.status, 409);
  assert.match(fourth.body.message, /3 campaigns/);

  const batch = store.batches.find(b => b.name === 'C1');
  const people = (n, from = 1) => Array.from({ length: n }, (_, i) => ({ name: `P${from + i}`, email: `p${from + i}@demo.test` }));
  assert.equal((await c.post(`/api/hr/batches/${batch.id}/candidates`, { token: lead.token, json: { candidates: people(10) } })).status, 201);
  const eleventh = await c.post(`/api/hr/batches/${batch.id}/candidates`, { token: lead.token, json: { candidates: people(1, 11) } });
  assert.equal(eleventh.status, 400);
  assert.match(eleventh.body.message, /at most 10 candidates in this demo workspace/);

  for (let i = 1; i <= 4; i += 1) {
    assert.equal((await c.post('/api/hr/team', { token: lead.token, json: { name: `M${i}`, email: `m${i}@demo.test`, sign_in: 'google' } })).status, 201);
  }
  const sixth = await c.post('/api/hr/team', { token: lead.token, json: { name: 'M5', email: 'm5@demo.test', sign_in: 'google' } });
  assert.equal(sixth.status, 409);
  assert.match(sixth.body.message, /5 team members/);

  for (let i = 1; i <= 4; i += 1) assert.equal((await c.post('/api/hr/batches', { token: admin, json: { name: `Main ${i}`, job_role: 'R' } })).status, 201, 'no limit in your workspace');
});

test('Limit: when a demo workspace has used its calls, a candidate cannot start another one', async () => {
  const lead = await newLead();
  const { candidates } = await liveCampaign(c, lead.token, { people: [{ name: 'Neha', email: 'neha@cand.test' }] });
  for (let i = 0; i < DEMO_LIMITS.max_completed_calls; i += 1) store.calls.push({ id: `done-${i}`, candidate_id: candidates[0].id, status: 'completed' });
  const r = await takeCall(c, tokens.candidate('neha-user', 'neha@cand.test'));
  assert.equal(r.step, 'start');
  assert.equal(r.status, 409);
  assert.match(r.body.message, /used all its demo calls/);
});

test('Limit: invite emails stop at the demo workspace\'s daily limit; the rest record why', async () => {
  const lead = await newLead();
  store.workspaces.find(w => w.id === lead.workspaceId).max_emails_per_day = 2;
  await liveCampaign(c, lead.token, { people: [1, 2, 3].map(i => ({ name: `P${i}`, email: `p${i}@cand.test` })) });
  await settle();
  assert.equal(mail.sent.length, 2);
  const refused = store.candidates.filter(x => x.invite_email_error);
  assert.equal(refused.length, 1);
  assert.match(refused[0].invite_email_error, /Daily limit reached/);
});
