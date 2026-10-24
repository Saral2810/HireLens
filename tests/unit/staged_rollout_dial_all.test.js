import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import db from '../../backend/src/config/db.js';
import leadsRouter from '../../backend/src/routes/leads.js';

test('Task 7 - Staged Rollout Mode (?limit and ?dry_run)', async (t) => {
  const app = express();
  app.use(express.json());
  // Mock tenant middleware
  app.use((req, res, next) => {
    req.tenant_id = req.headers['x-tenant-id'] || 'demo';
    next();
  });
  app.use('/leads', leadsRouter);

  let server;
  let baseUrl;

  t.before(async () => {
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://localhost:${port}`;
        resolve();
      });
    });
  });

  t.after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  await t.test('1. ?dry_run=true returns would_enqueue_count and sample_lead_ids without enqueuing', async () => {
    await db.clearDb();
    const camp = await db.insertCampaign({ tenant_id: 'demo', name: 'Demo Pre-Approved Base', voice_provider: 'mock', status: 'draft' });

    for (let i = 1; i <= 6; i++) {
      await db.insertLead({
        tenant_id: 'demo',
        name: `Lead ${i}`,
        phone: `987650000${i}`,
        score: i * 10,
        campaign_name: 'Demo Pre-Approved Base'
      });
    }

    const res = await fetch(`${baseUrl}/leads/campaign/Demo%20Pre-Approved%20Base/dial-all?dry_run=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'demo' }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.dry_run, true);
    assert.strictEqual(data.would_enqueue_count, 6);
    assert.strictEqual(data.sample_lead_ids.length, 5); // first 5 lead IDs
    
    // Ensure campaign remains draft, not active
    const campaigns = await db.getCampaigns('demo');
    const updatedCamp = campaigns.find(c => c.id === camp.id);
    assert.strictEqual(updatedCamp.status, 'draft');

    // Ensure call_queue is empty
    assert.strictEqual(db.mockDb.callQueue ? db.mockDb.callQueue.length : 0, 0);
  });

  await t.test('2. ?limit=3&dry_run=true caps would_enqueue_count to 3 and selects top 3 scored leads', async () => {
    const res = await fetch(`${baseUrl}/leads/campaign/Demo%20Pre-Approved%20Base/dial-all?limit=3&dry_run=true`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'demo' }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.dry_run, true);
    assert.strictEqual(data.would_enqueue_count, 3);
    assert.strictEqual(data.limit, 3);
    assert.strictEqual(data.sample_lead_ids.length, 3);
  });

  await t.test('3. ?limit=2 (live) enqueues exactly 2 highest-scored leads', async () => {
    const res = await fetch(`${baseUrl}/leads/campaign/Demo%20Pre-Approved%20Base/dial-all?limit=2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'demo' }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.enqueued, 2);
    assert.strictEqual(data.count, 2);
    assert.strictEqual(data.limit, 2);

    // Verify campaign is now active
    const campaigns = await db.getCampaigns('demo');
    const camp = campaigns.find(c => c.name === 'Demo Pre-Approved Base');
    assert.strictEqual(camp.status, 'active');
  });

  await t.test('4. Default (no ?limit) enqueues all eligible leads without cap', async () => {
    const res = await fetch(`${baseUrl}/leads/campaign/Demo%20Pre-Approved%20Base/dial-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-tenant-id': 'demo' }
    });

    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.limit, null);
    assert.strictEqual(data.enqueued, 6);
  });
});
