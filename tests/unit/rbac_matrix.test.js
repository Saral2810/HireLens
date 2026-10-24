import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import app from '../../backend/src/app.js';
import db from '../../backend/src/config/db.js';

let server;
let port;
let baseUrl;

test.before(async () => {
  process.env.NODE_ENV = 'test';

  // Seed mockDb workspaces and users for testing
  db.mockDb.tenantConfigs['tenant-alpha'] = {
    tenant_id: 'tenant-alpha',
    name: 'Alpha Corp',
    status: 'active',
    aiAgent: { persona: 'Alpha persona' }
  };
  db.mockDb.tenantConfigs['tenant-beta'] = {
    tenant_id: 'tenant-beta',
    name: 'Beta Corp',
    status: 'active',
    aiAgent: { persona: 'Beta persona' }
  };

  db.mockDb.tenantUsers.push(
    { id: 'tu-1', tenant_id: 'tenant-alpha', user_id: 'owner-alpha-id', role: 'owner' },
    { id: 'tu-2', tenant_id: 'tenant-alpha', user_id: 'admin-alpha-id', role: 'admin' },
    { id: 'tu-3', tenant_id: 'tenant-alpha', user_id: 'member-alpha-id', role: 'member' },
    { id: 'tu-4', tenant_id: 'tenant-beta', user_id: 'owner-beta-id', role: 'owner' }
  );

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

// ─────────────────────────────────────────────────────────
// 1. SUPER ADMIN PERMISSIONS & GLOBAL ACCESS
// ─────────────────────────────────────────────────────────

test('Super Admin - Can view all workspaces', async () => {
  const res = await fetch(`${baseUrl}/tenants`, {
    headers: { Authorization: 'Bearer mock-superadmin' }
  });
  assert.strictEqual(res.status, 200);
  const tenants = await res.json();
  const ids = tenants.map(t => t.tenant_id);
  assert.ok(ids.includes('tenant-alpha'));
  assert.ok(ids.includes('tenant-beta'));
});

test('Super Admin - Can create a new workspace', async () => {
  const res = await fetch(`${baseUrl}/tenants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-superadmin'
    },
    body: JSON.stringify({
      tenant_id: 'tenant-gamma',
      name: 'Gamma Corp',
      adminEmail: 'admin@gamma.com',
      adminPassword: 'Password123!'
    })
  });
  assert.strictEqual(res.status, 201);
  const created = await res.json();
  assert.strictEqual(created.tenant_id, 'tenant-gamma');
});

test('Super Admin - Can edit any workspace', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-superadmin'
    },
    body: JSON.stringify({ name: 'Alpha Corp Updated' })
  });
  assert.strictEqual(res.status, 200);
  const updated = await res.json();
  assert.strictEqual(updated.name, 'Alpha Corp Updated');
});

test('Super Admin - Can provision user in any workspace', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-superadmin'
    },
    body: JSON.stringify({
      email: 'newuser@alpha.com',
      password: 'SecurePass123!',
      role: 'member'
    })
  });
  assert.strictEqual(res.status, 201);
});

test('Super Admin - Can delete any workspace', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-gamma`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer mock-superadmin' }
  });
  assert.strictEqual(res.status, 204);
});

// ─────────────────────────────────────────────────────────
// 2. TENANT OWNER PERMISSIONS & WORKSPACE ISOLATION
// ─────────────────────────────────────────────────────────

test('Tenant Owner - Sees only assigned workspace', async () => {
  const res = await fetch(`${baseUrl}/tenants`, {
    headers: { Authorization: 'Bearer mock-owner:tenant-alpha:owner-alpha-id' }
  });
  assert.strictEqual(res.status, 200);
  const tenants = await res.json();
  assert.strictEqual(tenants.length, 1);
  assert.strictEqual(tenants[0].tenant_id, 'tenant-alpha');
  assert.strictEqual(tenants[0].user_role, 'owner');
});

test('Tenant Owner - Can edit own workspace', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-owner:tenant-alpha:owner-alpha-id'
    },
    body: JSON.stringify({ name: 'Alpha Corp Renamed by Owner' })
  });
  assert.strictEqual(res.status, 200);
});

test('Tenant Owner - Can provision users in own workspace', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-owner:tenant-alpha:owner-alpha-id'
    },
    body: JSON.stringify({
      email: 'member2@alpha.com',
      password: 'SecurePass123!',
      role: 'member'
    })
  });
  assert.strictEqual(res.status, 201);
});

test('Tenant Owner - Cannot create new global workspace (403 Forbidden)', async () => {
  const res = await fetch(`${baseUrl}/tenants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-owner:tenant-alpha:owner-alpha-id'
    },
    body: JSON.stringify({
      tenant_id: 'rogue-tenant',
      name: 'Rogue Tenant',
      adminEmail: 'rogue@rogue.com',
      adminPassword: 'Password123!'
    })
  });
  assert.strictEqual(res.status, 403);
});

test('Tenant Owner - Cannot access another tenant workspace (403 Forbidden)', async () => {
  const res = await fetch(`${baseUrl}/leads?tenant_id=tenant-beta`, {
    headers: { Authorization: 'Bearer mock-owner:tenant-alpha:owner-alpha-id' }
  });
  assert.strictEqual(res.status, 403);
});

// ─────────────────────────────────────────────────────────
// 3. TENANT ADMIN PERMISSIONS
// ─────────────────────────────────────────────────────────

test('Tenant Admin - Can edit workspace settings', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-admin:tenant-alpha:admin-alpha-id'
    },
    body: JSON.stringify({ name: 'Alpha Corp Renamed by Admin' })
  });
  assert.strictEqual(res.status, 200);
});

test('Tenant Admin - Can provision team member', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-admin:tenant-alpha:admin-alpha-id'
    },
    body: JSON.stringify({
      email: 'member3@alpha.com',
      password: 'SecurePass123!',
      role: 'member'
    })
  });
  assert.strictEqual(res.status, 201);
});

test('Tenant Admin - Cannot delete workspace (403 Forbidden)', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer mock-admin:tenant-alpha:admin-alpha-id' }
  });
  assert.strictEqual(res.status, 403);
});

// ─────────────────────────────────────────────────────────
// 4. TENANT MEMBER RESTRICTIONS (READ ONLY / EDIT HIDDEN)
// ─────────────────────────────────────────────────────────

test('Tenant Member - Can read leads for own workspace', async () => {
  const res = await fetch(`${baseUrl}/leads?tenant_id=tenant-alpha`, {
    headers: { Authorization: 'Bearer mock-member:tenant-alpha:member-alpha-id' }
  });
  assert.strictEqual(res.status, 200);
});

test('Tenant Member - Cannot edit workspace settings (403 Forbidden)', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-member:tenant-alpha:member-alpha-id'
    },
    body: JSON.stringify({ name: 'Illegal Rename' })
  });
  assert.strictEqual(res.status, 403);
});

test('Tenant Member - Cannot provision users (403 Forbidden)', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer mock-member:tenant-alpha:member-alpha-id'
    },
    body: JSON.stringify({
      email: 'illegal@alpha.com',
      password: 'Password123!',
      role: 'member'
    })
  });
  assert.strictEqual(res.status, 403);
});

test('Tenant Member - Cannot delete workspace (403 Forbidden)', async () => {
  const res = await fetch(`${baseUrl}/tenants/tenant-alpha`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer mock-member:tenant-alpha:member-alpha-id' }
  });
  assert.strictEqual(res.status, 403);
});
