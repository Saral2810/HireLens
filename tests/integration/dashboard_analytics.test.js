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

  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const twentyDaysAgo = new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString();

  db.mockDb.leads.push(
    { id: 'lead-1', tenant_id: 'test-tenant', campaign_name: 'camp-A', score: 90, status: 'won', created_at: threeDaysAgo, updated_at: threeDaysAgo },
    { id: 'lead-2', tenant_id: 'test-tenant', campaign_name: 'camp-A', score: 50, status: 'won', created_at: tenDaysAgo, updated_at: tenDaysAgo },
    { id: 'lead-3', tenant_id: 'test-tenant', campaign_name: 'camp-B', score: 85, status: 'queued', created_at: tenDaysAgo, updated_at: tenDaysAgo },
    { id: 'lead-4', tenant_id: 'test-tenant', campaign_name: 'camp-B', score: 20, status: 'closed', created_at: twentyDaysAgo, updated_at: twentyDaysAgo }
  );

  db.mockDb.callSessions.push(
    { id: 'sess-1', tenant_id: 'test-tenant', lead_id: 'lead-1', disposition: 'won', started_at: threeDaysAgo },
    { id: 'sess-2', tenant_id: 'test-tenant', lead_id: 'lead-2', disposition: 'won', started_at: tenDaysAgo },
    { id: 'sess-3', tenant_id: 'test-tenant', lead_id: 'lead-3', disposition: 'called', started_at: tenDaysAgo }
  );

  db.mockDb.tenantConfigs['test-tenant'] = { onboarding_config: { thresholds: { hot: 80, warm: 50 } } };

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

test('Dashboard Analytics - Filters and Deltas', async () => {
  const resGlobal = await fetch(`${baseUrl}/leads/analytics/summary?tenant_id=test-tenant&date_range=all&graph_range=monthly`);
  const dataGlobal = await resGlobal.json();
  
  assert.strictEqual(dataGlobal.success, true);
  
  const kpis = dataGlobal.kpis;
  assert.strictEqual(kpis.total_leads, 4);
  assert.strictEqual(kpis.won, 2);
  assert.strictEqual(kpis.hot_leads, 2); 
  
  assert.strictEqual(kpis.deltas.total_leads, -50.0);
  assert.strictEqual(kpis.deltas.hot_leads, 0.0);

  const trend = dataGlobal.leads_won_trend;
  assert.ok(trend.length === 30);
  const sumWon = trend.reduce((sum, t) => sum + t.count, 0);
  assert.strictEqual(sumWon, 2); 

  const resFiltered = await fetch(`${baseUrl}/leads/analytics/summary?tenant_id=test-tenant&campaign_id=camp-A&date_range=all&graph_range=monthly`);
  const dataFiltered = await resFiltered.json();
  
  assert.strictEqual(dataFiltered.success, true);
  assert.strictEqual(dataFiltered.kpis.total_leads, 2); 
  assert.strictEqual(dataFiltered.kpis.won, 2);
  assert.strictEqual(dataFiltered.kpis.hot_leads, 1);
  
  assert.strictEqual(dataFiltered.top_campaigns.length, 1);
  assert.strictEqual(dataFiltered.top_campaigns[0].campaign_id, 'camp-A');
  assert.strictEqual(dataFiltered.top_campaigns[0].hot_leads, 1);
});
