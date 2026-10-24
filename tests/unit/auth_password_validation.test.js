import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import app from '../../backend/src/app.js';

// Offline mock-mode login rules (no Supabase connected):
//   superadmin@local.dev (or any SUPER_ADMIN_EMAILS entry) + MOCK_ADMIN_PASSWORD (default ChangeMe@123)
//   mock tenant users + their temp_password
let server;
let baseUrl;

test.before(async () => {
  process.env.NODE_ENV = 'test';
  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      baseUrl = `http://localhost:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => new Promise((resolve) => {
  if (server) {
    if (server.closeAllConnections) server.closeAllConnections();
    server.close(() => resolve());
  } else resolve();
}));

const login = (email, password) => fetch(`${baseUrl}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password })
});

test('1. Reject Super Admin login with invalid password', async () => {
  const res = await login('superadmin@local.dev', 'wrong_password_123');
  assert.strictEqual(res.status, 401);
});

test('2. Accept Super Admin login with MOCK_ADMIN_PASSWORD', async () => {
  const res = await login('superadmin@local.dev', process.env.MOCK_ADMIN_PASSWORD || 'ChangeMe@123');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.user.isSuperAdmin, true);
  assert.ok(data.token);
});

test('3. Old hardcoded backdoor passwords no longer work', async () => {
  for (const pwd of ['admin123', 'Admin@123', 'Password@123', 'superadmin']) {
    const res = await login('superadmin@local.dev', pwd);
    assert.strictEqual(res.status, 401, `backdoor password "${pwd}" must be rejected`);
  }
});

test('4. Reject tenant user with invalid password', async () => {
  const res = await login('admin@demo.local', 'incorrect_pwd_456');
  assert.strictEqual(res.status, 401);
});

test('5. Accept tenant user with their temp_password', async () => {
  const res = await login('admin@demo.local', 'ChangeMe@123');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.user.isSuperAdmin, false);
  assert.deepStrictEqual(data.user.allowedTenants, ['demo']);
});

test('6. Reject unknown user', async () => {
  const res = await login('randomhacker@nowhere.com', 'any_random_password');
  assert.strictEqual(res.status, 401);
});

test('7. Enforce tenant isolation for a tenant account', async () => {
  const res = await fetch(`${baseUrl}/leads?tenant_id=test-tenant`, {
    headers: { Authorization: 'Bearer mock-tenant_demo' }
  });
  assert.strictEqual(res.status, 403);
});
