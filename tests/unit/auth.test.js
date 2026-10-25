import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import app from '../../backend/src/app.js';
import { requireAuth, requireRole } from '../../backend/src/middleware/auth.js';

let server;
let base;

before(async () => {
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
  assert.deepEqual(await res.json(), { id: 'c1', email: 'cand@test.local', role: 'candidate', name: null });
});

test('HR endpoints refuse candidates and signed-out users', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const post = (token, path = `/api/hr/candidates/${id}/invite-link`) => fetch(base + path, { method: 'POST', headers: token ? { Authorization: `Bearer ${token}` } : {} });
  assert.equal((await post()).status, 401);
  assert.equal((await post('test:candidate:c1')).status, 403);
  // HR passes the role check and reaches the route, which needs the database (not available in tests).
  assert.equal((await post('test:superadmin:hr1')).status, 503);
  // Malformed IDs never reach the database.
  assert.equal((await post('test:superadmin:hr1', '/api/hr/candidates/not-a-uuid/invite-link')).status, 404);
});

test('HR batch endpoints validate input before touching the database', async () => {
  const send = (method, path, body) => fetch(base + path, {
    method, headers: { Authorization: 'Bearer test:superadmin:hr1', 'Content-Type': 'application/json' }, body: body && JSON.stringify(body)
  });
  const bad = await send('POST', '/api/hr/batches', { name: '', job_role: 'Engineer' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).message, /Batch name is required/);
  assert.equal((await send('GET', '/api/hr/batches', null)).status, 503);
  assert.equal((await fetch(base + '/api/hr/batches', { headers: { Authorization: 'Bearer test:candidate:c1' } })).status, 403);
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
