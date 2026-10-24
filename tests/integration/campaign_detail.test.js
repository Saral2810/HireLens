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

  db.mockDb.leads.push(
    { id: 'lead-hdfc-1', tenant_id: 'default', campaign_name: 'HDFC-Credit', score: 90, status: 'won', created_at: threeDaysAgo, updated_at: threeDaysAgo },
    { id: 'lead-hdfc-2', tenant_id: 'default', campaign_name: 'HDFC-Credit', score: 65, status: 'called', created_at: tenDaysAgo, updated_at: tenDaysAgo },
    { id: 'lead-demo-1', tenant_id: 'default', campaign_name: 'Demo-Loans', score: 80, status: 'queued', created_at: tenDaysAgo, updated_at: tenDaysAgo }
  );

  db.mockDb.callSessions.push(
    { id: 'sess-hdfc-1', tenant_id: 'default', lead_id: 'lead-hdfc-1', disposition: 'won', started_at: threeDaysAgo },
    { id: 'sess-hdfc-2', tenant_id: 'default', lead_id: 'lead-hdfc-2', disposition: 'called', started_at: tenDaysAgo }
  );

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      port = server.address().port;
      baseUrl = `http://localhost:${port}/leads/analytics/summary?tenant_id=default`;
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

// Test mock endpoint
test('Campaign Detail SSE Payload tests', async (t) => {

  await t.test('Payload Shape', async () => {
    const res = await fetch(`${baseUrl}&campaign_id=HDFC-Credit`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.ok(data.campaign_meta);
    assert.strictEqual(data.campaign_meta.id, 'HDFC-Credit');
    assert.ok(data.kpis);
    assert.ok(data.heatmap);
    assert.strictEqual(data.heatmap.length, 7);
    assert.strictEqual(data.heatmap[0].length, 12);
    assert.ok(data.recent_calls);
    assert.ok(data.funnel);
    assert.ok(data.attention.hot_leads.length <= 3);
    assert.ok(data.attention.escalations.length <= 3);
  });

  await t.test('Campaign Scoping', async () => {
    const res1 = await fetch(`${baseUrl}&campaign_id=HDFC-Credit`);
    const data1 = await res1.json();
    
    const res2 = await fetch(`${baseUrl}&campaign_id=Demo-Loans`);
    const data2 = await res2.json();
    
    assert.strictEqual(data1.campaign_meta.id, 'HDFC-Credit');
    assert.strictEqual(data2.campaign_meta.id, 'Demo-Loans');
    
    // They should have different lead counts (or at least scoping applies)
    assert.notDeepEqual(data1.recent_calls, data2.recent_calls);
  });

  await t.test('Empty State', async () => {
    const res = await fetch(`${baseUrl}&campaign_id=UNKNOWN-CAMPAIGN-123`);
    const data = await res.json();
    assert.strictEqual(data.success, true);
    assert.strictEqual(data.campaign_meta, null);
    assert.strictEqual(data.kpis.total_leads, 0);
    assert.strictEqual(data.kpis.attempts, 0);
    assert.strictEqual(data.kpis.won_rate, 0);
    assert.strictEqual(data.recent_calls.length, 0);
  });

  await t.test('Date Range Scoping', async () => {
    const resToday = await fetch(`${baseUrl}&campaign_id=HDFC-Credit&date_range=today`);
    const dataToday = await resToday.json();
    
    const res30d = await fetch(`${baseUrl}&campaign_id=HDFC-Credit&date_range=30d`);
    const data30d = await res30d.json();
    
    // 30d should naturally have more or equal leads than today
    assert.ok(data30d.kpis.total_leads >= dataToday.kpis.total_leads);
  });
});
