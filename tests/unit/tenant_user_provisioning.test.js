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
    if (server) {
      if (server.closeAllConnections) server.closeAllConnections();
      server.close(() => resolve());
    } else {
      resolve();
    }
  });
});

test('1. Super Admin creates a new client tenant with credentials via POST /tenants', async () => {
  const payload = {
    tenant_id: 'acme-corp',
    name: 'Acme Corporation',
    adminEmail: 'clientadmin@acme.com',
    adminPassword: 'securepassword123',
    aiAgent: { persona: 'Acme Support AI' },
    queue: { maxAttempts: 4 }
  };

  const res = await fetch(`${baseUrl}/tenants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer mock-superadmin'
    },
    body: JSON.stringify(payload)
  });

  assert.strictEqual(res.status, 201);
  const data = await res.json();
  assert.strictEqual(data.tenant_id, 'acme-corp');
  assert.strictEqual(data.name, 'Acme Corporation');
  assert.ok(data.initialApiKey, 'Auto-generates initial API key');
});

test('2. Super Admin provisions additional user credentials for an existing tenant via POST /tenants/:tenant_id/users', async () => {
  const payload = {
    email: 'operator1@acme.com',
    password: 'operatorpassword123',
    role: 'member'
  };

  const res = await fetch(`${baseUrl}/tenants/acme-corp/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer mock-superadmin'
    },
    body: JSON.stringify(payload)
  });

  assert.strictEqual(res.status, 201);
  const data = await res.json();
  assert.strictEqual(data.email, 'operator1@acme.com');
  assert.strictEqual(data.role, 'member');
});

test('3. Super Admin retrieves list of provisioned users for tenant via GET /tenants/:tenant_id/users', async () => {
  const res = await fetch(`${baseUrl}/tenants/acme-corp/users`, {
    headers: {
      'Authorization': 'Bearer mock-superadmin'
    }
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(Array.isArray(data.users), 'Returns array of users');
  assert.ok(data.users.length >= 1, 'Contains provisioned users');
});

test('4. Non-superadmin client user cannot create new tenants', async () => {
  const payload = {
    tenant_id: 'hacker-tenant',
    name: 'Hacker Workspace',
    adminEmail: 'hacker@evil.com',
    adminPassword: 'password123'
  };

  const res = await fetch(`${baseUrl}/tenants`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer mock-tenant_demo'
    },
    body: JSON.stringify(payload)
  });

  assert.strictEqual(res.status, 403, 'Client admin cannot create other workspaces');
});

test('5. Non-superadmin client user cannot access other tenants settings', async () => {
  const res = await fetch(`${baseUrl}/tenants/acme-corp`, {
    headers: {
      'Authorization': 'Bearer mock-tenant_demo'
    }
  });

  assert.strictEqual(res.status, 403, 'Client user cannot access another tenant');
});

test('6. Super Admin can view client credentials and share_package via GET /tenants/:tenant_id/users', async () => {
  const res = await fetch(`${baseUrl}/tenants/acme-corp/users`, {
    headers: {
      'Authorization': 'Bearer mock-superadmin'
    }
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.ok(data.users.length > 0);
  const user = data.users.find(u => u.email === 'operator1@acme.com');
  assert.ok(user, 'Finds operator1');
  assert.ok(user.temp_password, 'Has viewable temporary password');
  assert.ok(user.share_package, 'Contains pre-formatted share_package');
  assert.ok(user.share_package.formatted_message.includes('operator1@acme.com'));
  assert.ok(user.share_package.whatsapp_url.startsWith('https://api.whatsapp.com/send'));
  assert.ok(user.share_package.mailto_url.startsWith('mailto:operator1@acme.com'));
});

test('7. Super Admin can reset user credentials and get a fresh share package', async () => {
  const usersRes = await fetch(`${baseUrl}/tenants/acme-corp/users`, {
    headers: { 'Authorization': 'Bearer mock-superadmin' }
  });
  const usersData = await usersRes.json();
  const user = usersData.users[0];

  const res = await fetch(`${baseUrl}/tenants/acme-corp/users/${user.id}/reset-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer mock-superadmin'
    },
    body: JSON.stringify({ new_password: 'NewAcmePassword2026!' })
  });

  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.password, 'NewAcmePassword2026!');
  assert.ok(data.share_package.formatted_message.includes('NewAcmePassword2026!'));
});

test('8. superadmin@local.dev is strictly excluded from tenant user listings', async () => {
  const res = await fetch(`${baseUrl}/tenants/demo/users`, {
    headers: { 'Authorization': 'Bearer mock-superadmin' }
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  const superAdminInList = data.users.find(u => (u.email || '').toLowerCase() === 'superadmin@local.dev');
  assert.strictEqual(superAdminInList, undefined, 'Super Admin email must never appear in tenant user listings');
  
  // Verify client user has plain-text temporary password
  const clientUser = data.users.find(u => u.email === 'admin@demo.local');
  assert.ok(clientUser && clientUser.temp_password === 'ChangeMe@123', 'Temp password is visible to admins');
});

test('9. Super Admin can delete a tenant user credential via DELETE /tenants/:tenant_id/users/:user_id', async () => {
  // 1. Provision user to delete
  const provRes = await fetch(`${baseUrl}/tenants/acme-corp/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer mock-superadmin'
    },
    body: JSON.stringify({ email: 'to_delete@acme.com', role: 'member' })
  });
  assert.strictEqual(provRes.status, 201);
  const provData = await provRes.json();

  // 2. Delete user
  const delRes = await fetch(`${baseUrl}/tenants/acme-corp/users/${provData.user_id}`, {
    method: 'DELETE',
    headers: { 'Authorization': 'Bearer mock-superadmin' }
  });
  assert.strictEqual(delRes.status, 200);

  // 3. Confirm user is deleted from listings
  const listRes = await fetch(`${baseUrl}/tenants/acme-corp/users`, {
    headers: { 'Authorization': 'Bearer mock-superadmin' }
  });
  const listData = await listRes.json();
  const deletedUser = listData.users.find(u => u.email === 'to_delete@acme.com');
  assert.strictEqual(deletedUser, undefined, 'User was deleted successfully');
});


