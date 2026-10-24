import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import app from '../../backend/src/app.js';
import db from '../../backend/src/config/db.js';

let server;
let baseUrl;
const TENANT = 'test-integration-tenant';
const AUTH_HEADER = `Bearer admin:${TENANT}:admin-uid`;

test.before(async () => {
  process.env.NODE_ENV = 'test';
  await db.clearDb();

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
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

test('Integration: Scheduler Routes and Campaign Retry', async (t) => {
  let createdJobId = null;

  await t.test('POST /scheduler - create campaign dial scheduled task', async () => {
    const futureTime = new Date(Date.now() + 1800000).toISOString();
    const res = await fetch(`${baseUrl}/scheduler?tenant_id=${TENANT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH_HEADER
      },
      body: JSON.stringify({
        tenant_id: TENANT,
        type: 'campaign_dial',
        target_campaign: 'Integration Beta',
        scheduled_at: futureTime,
        max_concurrency: 5,
        whatsapp_threshold: 75
      })
    });

    const body = await res.json();
    assert.strictEqual(res.status, 201);
    assert.strictEqual(body.success, true);
    assert.ok(body.jobId);
    assert.strictEqual(body.job.type, 'campaign_dial');
    assert.strictEqual(body.job.target_campaign, 'Integration Beta');
    createdJobId = body.jobId;
  });

  await t.test('GET /scheduler - retrieve scheduled tasks', async () => {
    const res = await fetch(`${baseUrl}/scheduler?tenant_id=${TENANT}`, {
      headers: { 'Authorization': AUTH_HEADER }
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.ok(Array.isArray(body.jobs));
    const found = body.jobs.find(j => j.id === createdJobId);
    assert.ok(found, 'Created job should be in scheduler listing');
  });

  await t.test('POST /scheduler/:id/trigger - manually trigger scheduled task', async () => {
    db.mockDb.leads.push({
      id: 'lead-sched-int-1',
      tenant_id: TENANT,
      phone: '9876543210',
      campaign_name: 'Integration Beta',
      status: 'ingested'
    });

    const res = await fetch(`${baseUrl}/scheduler/${createdJobId}/trigger?tenant_id=${TENANT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH_HEADER
      },
      body: JSON.stringify({ tenant_id: TENANT })
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
  });

  await t.test('POST /leads/campaign/:campaign_name/retry-failed - retry failed contacts', async () => {
    db.mockDb.campaigns.push({
      id: 'camp-beta',
      tenant_id: TENANT,
      name: 'Integration Beta'
    });
    db.mockDb.leads.push({
      id: 'lead-sched-failed-1',
      tenant_id: TENANT,
      phone: '9876543211',
      campaign_name: 'Integration Beta',
      status: 'called'
    });

    const res = await fetch(`${baseUrl}/leads/campaign/Integration%20Beta/retry-failed?tenant_id=${TENANT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': AUTH_HEADER
      }
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
    assert.ok(body.count >= 1, 'Should re-queue at least 1 failed lead');
  });

  await t.test('DELETE /scheduler/:id - delete scheduled task', async () => {
    const res = await fetch(`${baseUrl}/scheduler/${createdJobId}?tenant_id=${TENANT}`, {
      method: 'DELETE',
      headers: { 'Authorization': AUTH_HEADER }
    });

    const body = await res.json();
    assert.strictEqual(res.status, 200);
    assert.strictEqual(body.success, true);
  });
});
