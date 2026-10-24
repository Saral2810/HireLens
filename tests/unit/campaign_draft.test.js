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

test('Campaign Draft: GET /campaigns/draft returns null when no draft exists', async () => {
  const res = await fetch(`${baseUrl}/campaigns/draft?tenant_id=draft-tenant-1`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.draft, null);
});

test('Campaign Draft: POST /campaigns/draft saves in-progress draft and GET retrieves it', async () => {
  const draftPayload = {
    tenant_id: 'draft-tenant-1',
    step: 3,
    campaign_name: 'Q4 Product Launch Draft',
    form_data: {
      industry: 'Finance & Insurance',
      objective: 'Qualify pre-approved prospects',
      concurrency: 4,
      parsedLeadsCount: 15,
      mappingConfig: { phone: 'Contact Phone', name: 'Full Name' }
    }
  };

  const postRes = await fetch(`${baseUrl}/campaigns/draft`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draftPayload)
  });

  assert.strictEqual(postRes.status, 200);
  const postData = await postRes.json();
  assert.strictEqual(postData.success, true);
  assert.strictEqual(postData.draft.step, 3);
  assert.strictEqual(postData.draft.campaign_name, 'Q4 Product Launch Draft');
  assert.strictEqual(postData.draft.tenant_id, 'draft-tenant-1');

  // Verify GET retrieves it
  const getRes = await fetch(`${baseUrl}/campaigns/draft?tenant_id=draft-tenant-1`);
  assert.strictEqual(getRes.status, 200);
  const getData = await getRes.json();
  assert.strictEqual(getData.success, true);
  assert.ok(getData.draft);
  assert.strictEqual(getData.draft.step, 3);
  assert.strictEqual(getData.draft.campaign_name, 'Q4 Product Launch Draft');
  assert.strictEqual(getData.draft.form_data.industry, 'Finance & Insurance');
});

test('Campaign Draft: Tenant Isolation - draft for tenant-A is not accessible by tenant-B', async () => {
  const res = await fetch(`${baseUrl}/campaigns/draft?tenant_id=draft-tenant-2`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.strictEqual(data.draft, null);
});

test('Campaign Draft: DELETE /campaigns/draft discards the draft', async () => {
  const delRes = await fetch(`${baseUrl}/campaigns/draft?tenant_id=draft-tenant-1`, {
    method: 'DELETE'
  });
  assert.strictEqual(delRes.status, 200);
  const delData = await delRes.json();
  assert.strictEqual(delData.success, true);

  // Verify it is gone
  const getRes = await fetch(`${baseUrl}/campaigns/draft?tenant_id=draft-tenant-1`);
  const getData = await getRes.json();
  assert.strictEqual(getData.draft, null);
});

test('Campaign Draft: Path Parameter Routing - GET, POST, DELETE on /campaigns/draft/:tenant_id', async () => {
  const tenantId = 'param-tenant-draft';
  const draft = {
    step: 2,
    campaign_name: 'Param Route Campaign',
    industry: 'Healthcare'
  };

  // POST /campaigns/draft/:tenant_id
  const postRes = await fetch(`${baseUrl}/campaigns/draft/${tenantId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft)
  });
  assert.strictEqual(postRes.status, 200);
  const postData = await postRes.json();
  assert.strictEqual(postData.success, true);
  assert.strictEqual(postData.draft.tenant_id, tenantId);

  // GET /campaigns/draft/:tenant_id
  const getRes = await fetch(`${baseUrl}/campaigns/draft/${tenantId}`);
  assert.strictEqual(getRes.status, 200);
  const getData = await getRes.json();
  assert.strictEqual(getData.draft.campaign_name, 'Param Route Campaign');

  // DELETE /campaigns/draft/:tenant_id
  const delRes = await fetch(`${baseUrl}/campaigns/draft/${tenantId}`, {
    method: 'DELETE'
  });
  assert.strictEqual(delRes.status, 200);

  // Check it's null
  const checkRes = await fetch(`${baseUrl}/campaigns/draft/${tenantId}`);
  const checkData = await checkRes.json();
  assert.strictEqual(checkData.draft, null);
});

test('Campaign Draft: Alignment on /leads/draft and /leads/campaigns/draft endpoints', async () => {
  const tenantId = 'leads-route-tenant';
  const draft = {
    step: 4,
    campaign_name: 'Leads Base Campaign Draft',
    industry: 'Automotive'
  };

  // POST /leads/draft
  const postRes = await fetch(`${baseUrl}/leads/draft?tenant_id=${tenantId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(draft)
  });
  assert.strictEqual(postRes.status, 200);
  const postData = await postRes.json();
  assert.strictEqual(postData.success, true);

  // GET /leads/campaigns/draft
  const getRes = await fetch(`${baseUrl}/leads/campaigns/draft?tenant_id=${tenantId}`);
  assert.strictEqual(getRes.status, 200);
  const getData = await getRes.json();
  assert.strictEqual(getData.draft.campaign_name, 'Leads Base Campaign Draft');

  // DELETE /leads/draft
  const delRes = await fetch(`${baseUrl}/leads/draft?tenant_id=${tenantId}`, {
    method: 'DELETE'
  });
  assert.strictEqual(delRes.status, 200);

  // Verify gone via /leads/draft
  const finalCheck = await fetch(`${baseUrl}/leads/draft?tenant_id=${tenantId}`);
  const finalData = await finalCheck.json();
  assert.strictEqual(finalData.draft, null);
});

test('Campaign Draft: Launching a campaign via POST /leads/batch automatically purges tenant draft', async () => {
  const tenantId = 'batch-purge-tenant';
  
  // 1. Save draft
  await db.upsertCampaignDraft(tenantId, {
    step: 5,
    campaign_name: 'Staged Batch Auto-Purge Campaign',
    industry: 'Real Estate'
  });

  const draftBefore = await db.getCampaignDraft(tenantId);
  assert.ok(draftBefore);
  assert.strictEqual(draftBefore.campaign_name, 'Staged Batch Auto-Purge Campaign');

  // 2. Launch campaign via POST /leads/batch
  const batchRes = await fetch(`${baseUrl}/leads/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: tenantId,
      campaign_name: 'Staged Batch Auto-Purge Campaign',
      leads: [
        { name: 'Alice Test', phone: '+919876543210' }
      ]
    })
  });
  assert.strictEqual(batchRes.status, 202);

  // 3. Verify draft was automatically purged from database
  const draftAfter = await db.getCampaignDraft(tenantId);
  assert.strictEqual(draftAfter, null, 'Draft must be purged when campaign is launched');
});

test('Campaign Draft: Active campaign name guard in db.upsertCampaignDraft blocks resurrection', async () => {
  const tenantId = 'guard-active-tenant';
  const campName = 'Active Live Campaign 2026';

  // 1. Create an active campaign
  await db.insertCampaign({
    tenant_id: tenantId,
    name: campName,
    total_leads: 10,
    status: 'active'
  });

  // 2. Attempt to save a draft for this launched campaign name (simulating a delayed in-flight auto-save)
  const result = await db.upsertCampaignDraft(tenantId, {
    step: 6,
    campaign_name: campName,
    objective: 'Should be rejected'
  });

  // 3. Verify it was skipped
  assert.strictEqual(result, null, 'Draft resurrection for an active campaign must be blocked');

  const retrievedDraft = await db.getCampaignDraft(tenantId);
  assert.strictEqual(retrievedDraft, null);
});
