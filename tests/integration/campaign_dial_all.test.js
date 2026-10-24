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
  await db.clearDb();

  // Seed mock database
  db.mockDb.campaigns.push({
    id: 'camp-demo-ten',
    tenant_id: 'demo',
    name: 'Demo Test Leads (Ten)',
    status: 'draft',
    max_concurrency: 3,
    whatsapp_threshold: 70
  });

  for (let i = 1; i <= 10; i++) {
    db.mockDb.leads.push({
      id: `lead-demo-${i}`,
      tenant_id: 'demo',
      campaign_name: 'Demo Test Leads (Ten)',
      phone: i === 1 ? '7001835922' : `996069704${i}`,
      score: 70 + i,
      status: i === 10 ? 'dnc' : 'created',
      raw_data: { attempts: 1 }
    });
  }

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

test('POST /campaign/:campaign_name/dial-all and GET dialer-status Integration', async (t) => {
  await t.test('Successfully triggers batch dialing with URL-encoded campaign name', async () => {
    const encodedName = encodeURIComponent('Demo Test Leads (Ten)');
    const res = await fetch(`${baseUrl}/leads/campaign/${encodedName}/dial-all?tenant_id=demo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ max_concurrency: 3, whatsapp_threshold: 70 })
    });

    const data = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.campaign, 'Demo Test Leads (Ten)');
    // Out of 10 leads, 1 is DNC, so 9 leads should be enqueued
    assert.strictEqual(data.enqueued_leads, 9);
  });

  await t.test('All non-terminal leads are set to queued and attempts reset to 0', async () => {
    const leads = db.mockDb.leads.filter(l => l.campaign_name === 'Demo Test Leads (Ten)');
    const userLead = leads.find(l => l.phone === '7001835922');
    assert.ok(userLead);
    assert.strictEqual(userLead.status, 'queued');
    assert.strictEqual(userLead.raw_data.attempts, 0);

    const dncLead = leads.find(l => l.id === 'lead-demo-10');
    assert.strictEqual(dncLead.status, 'dnc'); // Preserved terminal status
  });

  await t.test('GET /campaign/:campaign_name/dialer-status returns accurate progress counts', async () => {
    const encodedName = encodeURIComponent('Demo Test Leads (Ten)');
    const res = await fetch(`${baseUrl}/leads/campaign/${encodedName}/dialer-status?tenant_id=demo`);
    const statusData = await res.json();

    assert.strictEqual(res.status, 200);
    assert.strictEqual(statusData.success, true);
    assert.strictEqual(statusData.total_leads, 10);
    assert.strictEqual(statusData.queued_leads, 9);
    assert.strictEqual(statusData.active_leads, 0);
  });
});
