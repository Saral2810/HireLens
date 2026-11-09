// Integration: HR team sign-in with Google. Only HR accounts an Admin added on the Team page can sign
// in; a member added for Google has no password. Strangers, candidates and forged tokens all get the
// same 401, and no account is ever created for them. Fake DB; no network.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { installFakeDb } from '../helpers/fakeDb.js';
import { resetNetwork } from '../helpers/network.js';
import { startApp, tokens, liveCampaign } from '../helpers/http.js';

let app, store, c;
const admin = tokens.admin();
const CLIENT_ID = '123456-qa.apps.googleusercontent.com';
const NONCE = 'qa-nonce-0123456789abcdef';

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => { store = installFakeDb(); resetNetwork(); process.env.GOOGLE_CLIENT_ID = CLIENT_ID; });
afterEach(() => { delete process.env.GOOGLE_CLIENT_ID; });

/** A fake Google ID token as the fake DB accepts it (see helpers/fakeDb.js). */
function googleToken({ email, nonce = NONCE, aud = CLIENT_ID, sig = 'qa-google-sig' }) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${enc({ alg: 'RS256' })}.${enc({ email, aud, nonce: crypto.createHash('sha256').update(nonce).digest('hex'), name: 'QA Person' })}.${sig}`;
}
const hrGoogle = (email, extra = {}) => c.post('/api/auth/google/hr-token', { json: { credential: googleToken({ email, ...extra }), nonce: NONCE } });
const addMember = (json) => c.post('/api/hr/team', { token: admin, json });

test('Admin adds a member for Google sign-in: no password is set, and their first Google sign-in opens the HR account', async () => {
  const added = await addMember({ name: 'Neha Rao', email: 'Neha@QA.test', role: 'recruiter', sign_in: 'google' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.sign_in, 'google');
  assert.equal(store.authUsers.find(u => u.email === 'neha@qa.test').has_password, false, 'no password exists for a Google member');

  const signedIn = await hrGoogle('neha@qa.test');
  assert.equal(signedIn.status, 200, JSON.stringify(signedIn.body));
  assert.equal(signedIn.body.user.role, 'recruiter');
  assert.equal(signedIn.body.user.id, added.body.id, 'the same account the Admin created');
  assert.equal(signedIn.headers.get('cache-control'), 'no-store');
  // The session works on HR pages.
  assert.equal((await c.get('/api/hr/batches', { token: signedIn.body.token })).status, 200);
  assert.equal(store.authUsers.filter(u => u.email === 'neha@qa.test').length, 1, 'no second account');
});

test('An existing password HR account can also sign in with Google, and keeps its role', async () => {
  store.addProfile({ id: 'boss-1', email: 'boss@qa.test', role: 'superadmin' });
  const r = await hrGoogle('boss@qa.test');
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.user.id, r.body.user.role], ['boss-1', 'superadmin']);
});

test('Strangers, candidates and forged tokens get one identical 401, and no account is created', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha Rao', email: 'asha@qa.test' }] });
  store.addProfile({ id: 'hr-2', email: 'hr2@qa.test', role: 'recruiter' });
  const usersBefore = store.authUsers.length;

  const stranger = await hrGoogle('nobody@qa.test');
  const candidate = await hrGoogle('asha@qa.test');
  const forged = await hrGoogle('hr2@qa.test', { sig: 'forged' });
  const otherApp = await hrGoogle('hr2@qa.test', { aud: 'evil.apps.googleusercontent.com' });
  const replayed = await c.post('/api/auth/google/hr-token', { json: { credential: googleToken({ email: 'hr2@qa.test' }), nonce: 'a-different-nonce-123456' } });

  for (const r of [stranger, candidate, forged, otherApp, replayed]) {
    assert.equal(r.status, 401);
    assert.deepEqual(r.body, stranger.body, 'every refusal looks the same, so emails cannot be probed');
  }
  assert.match(stranger.body.message, /Ask your Admin/);
  assert.equal(store.authUsers.length, usersBefore, 'no account was created for anyone refused');
});

test('A removed member can no longer sign in with Google', async () => {
  const added = await addMember({ name: 'Ravi', email: 'ravi@qa.test', role: 'recruiter', sign_in: 'google' });
  assert.equal((await hrGoogle('ravi@qa.test')).status, 200);
  assert.equal((await c.del(`/api/hr/team/${added.body.id}`, { token: admin })).status, 204);
  assert.equal((await hrGoogle('ravi@qa.test')).status, 401);
});

test('An HR account signing in on the candidate Google route is still refused', async () => {
  await addMember({ name: 'Neha', email: 'neha@qa.test', role: 'recruiter', sign_in: 'google' });
  const r = await c.post('/api/auth/google/token', { json: { credential: googleToken({ email: 'neha@qa.test' }), nonce: NONCE } });
  assert.equal(r.status, 401);
});

test('Adding members: a password member still needs 8 characters; only an Admin can add; duplicates are refused', async () => {
  assert.equal((await addMember({ name: 'P', email: 'p@qa.test', role: 'recruiter', sign_in: 'password', password: 'short' })).status, 400);
  assert.equal((await addMember({ name: 'P', email: 'p@qa.test', role: 'recruiter' })).status, 400, 'password is the default method');
  const ok = await addMember({ name: 'P', email: 'p@qa.test', role: 'recruiter', password: 'password1' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.sign_in, 'password');
  assert.equal(store.authUsers.find(u => u.email === 'p@qa.test').has_password, true);
  assert.equal((await addMember({ name: 'P', email: 'p@qa.test', role: 'recruiter', sign_in: 'google' })).status, 409);
  const byRecruiter = await c.post('/api/hr/team', { token: tokens.recruiter('rec-a'), json: { name: 'X', email: 'x@qa.test', sign_in: 'google' } });
  assert.equal(byRecruiter.status, 403);
});

test('Bad input → 400; Google not set up → 503', async () => {
  for (const body of [{}, { credential: 'abc', nonce: NONCE }, { credential: 'a.b.c', nonce: 'short' }, { credential: ['a.b.c'], nonce: NONCE }]) {
    assert.equal((await c.post('/api/auth/google/hr-token', { json: body })).status, 400, JSON.stringify(body));
  }
  delete process.env.GOOGLE_CLIENT_ID;
  assert.equal((await c.post('/api/auth/google/hr-token', { json: { credential: 'a.b.c', nonce: NONCE } })).status, 503);
});
