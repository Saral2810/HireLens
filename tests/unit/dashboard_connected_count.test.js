import test from 'node:test';
import assert from 'node:assert';
import http from 'node:http';
import express from 'express';
import leadsRouter from '../../backend/src/routes/leads.js';
import db from '../../backend/src/config/db.js';

test('Dashboard Connected Count - should count a session with disposition=completed as connected', async (t) => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.tenant_id = 'test-tenant';
    next();
  });
  app.use('/leads', leadsRouter);

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  const originalGetLeads = db.getLeads;
  const originalGetCallSessions = db.getCallSessions;
  const originalGetOnboardingConfig = db.getOnboardingConfig;
  const originalGetCampaigns = db.getCampaigns;

  db.getLeads = async () => [
    { id: 'lead-1', status: 'called', score: 90, created_at: new Date().toISOString() }
  ];
  db.getCallSessions = async () => [
    {
      id: 'session-1',
      lead_id: 'lead-1',
      disposition: 'completed',
      started_at: new Date().toISOString()
    }
  ];
  db.getOnboardingConfig = async () => ({ thresholds: { hot: 80 } });
  db.getCampaigns = async () => [];

  try {
    const res = await fetch(`${baseUrl}/leads/analytics/summary`);
    assert.strictEqual(res.status, 200);
    const body = await res.json();

    // Check KPIs
    assert.ok(body.kpis);
    assert.strictEqual(body.kpis.connected, 1);

    // Check Funnel (attempted and connected)
    assert.ok(body.funnel);
    assert.strictEqual(body.funnel.connected, 1);
  } finally {
    db.getLeads = originalGetLeads;
    db.getCallSessions = originalGetCallSessions;
    db.getOnboardingConfig = originalGetOnboardingConfig;
    db.getCampaigns = originalGetCampaigns;
    await new Promise(resolve => server.close(resolve));
  }
});
