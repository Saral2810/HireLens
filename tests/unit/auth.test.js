import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import app from '../../backend/src/app.js';
import { requireAuth, requireRole, resolveRole } from '../../backend/src/middleware/auth.js';

let server;
let base;

before(async () => {
  process.env.SUPER_ADMIN_EMAILS = 'hr@test.local';
  // Mount throwaway protected routes next to the real app to exercise the middleware.
  const probe = express();
  probe.get('/probe/any', requireAuth, (req, res) => res.json(req.user));
  probe.get('/probe/hr', requireAuth, requireRole('superadmin'), (req, res) => res.json({ ok: true }));
  probe.get('/probe/candidate', requireAuth, requireRole('candidate'), (req, res) => res.json({ ok: true }));
  probe.use(app);
  server = probe.listen(0);
  await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const get = (path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });

test('resolveRole uses SUPER_ADMIN_EMAILS', () => {
  assert.equal(resolveRole({ email: 'HR@test.local' }), 'superadmin');
  assert.equal(resolveRole({ email: 'someone@test.local' }), 'candidate');
  assert.equal(resolveRole({}), 'candidate');
});

test('requests without a token are rejected', async () => {
  assert.equal((await get('/probe/any')).status, 401);
  assert.equal((await get('/api/auth/me')).status, 401);
});

test('test tokens with an unknown role are not accepted as test users', async () => {
  // Falls through to real token verification, which is unavailable without Supabase in tests.
  assert.equal((await get('/probe/any', 'test:admin:u1')).status, 503);
});

test('requireRole separates HR and candidates', async () => {
  assert.equal((await get('/probe/hr', 'test:superadmin:hr1')).status, 200);
  assert.equal((await get('/probe/hr', 'test:candidate:c1')).status, 403);
  assert.equal((await get('/probe/candidate', 'test:candidate:c1')).status, 200);
  assert.equal((await get('/probe/candidate', 'test:superadmin:hr1')).status, 403);
});

test('/api/auth/me returns the signed-in user', async () => {
  const res = await get('/api/auth/me', 'test:candidate:c1:cand@test.local');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: 'c1', email: 'cand@test.local', role: 'candidate' });
});

test('login requires email and password', async () => {
  const post = (body) => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ email: 'x@test.local' })).status, 400);
});

test('call-loop spike endpoints are HR-only', async () => {
  const post = (token) => fetch(base + '/api/spike/turn', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal((await post('test:candidate:c1')).status, 403);
  // HR passes the role check and reaches the route, which rejects the missing audio.
  assert.equal((await post('test:superadmin:hr1')).status, 400);
});

test('/health responds', async () => {
  const res = await get('/health');
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'ok');
});
