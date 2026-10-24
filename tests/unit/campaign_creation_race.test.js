import test from 'node:test';
import assert from 'node:assert';
import db from '../../backend/src/config/db.js';
import { enqueueJob } from '../../backend/src/services/jobQueue.js';
import { processNextJob } from '../../backend/src/services/jobQueue.js';

test('Campaign creation race condition - immediate launch', async (t) => {
  const TENANT_ID = 'test-race-tenant';
  const CAMPAIGN_ID = 'race_camp_01';
  
  // Setup: Clean mock data
  db.mockDb.leads = [];
  db.mockDb.campaigns = [];
  db.mockDb.jobs = [];
  db.mockDb.callQueue = [];
  db.mockDb.leadCampaigns = [];
  
  // Insert a campaign with immediate launch_strategy
  await db.insertCampaign({
    id: CAMPAIGN_ID,
    tenant_id: TENANT_ID,
    name: 'Immediate Launch Test',
    status: 'ingesting',
    total_leads: 3,
    launch_strategy: 'immediate'
  });

  const leads = [
    { client_id: 'client_1', phone: '9876543210', name: 'Race 1', source: 'test' },
    { client_id: 'client_2', phone: '9876543211', name: 'Race 2', source: 'test' },
    { client_id: 'client_3', phone: '9876543212', name: 'Race 3', source: 'test' },
  ];

  await enqueueJob(TENANT_ID, 'batch_ingest', {
    tenant_id: TENANT_ID,
    leads,
    dataset_id: 'test_ds',
    campaign_name: 'Immediate Launch Test',
    campaign_id: CAMPAIGN_ID
  });

  // Process the background ingestion job
  await processNextJob();

  // Assertions
  const camps = await db.getCampaigns(TENANT_ID);
  const camp = camps.find(c => c.id === CAMPAIGN_ID);

  // Status must be active (not draft)
  assert.strictEqual(camp.status, 'active', "Campaign status should be 'active' after immediate launch ingestion");

  // Check the call queue
  const enqueuedCalls = db.mockDb.callQueue.filter(q => q.campaign_id === CAMPAIGN_ID);
  assert.strictEqual(enqueuedCalls.length, 3, "Call queue must have exactly 3 entries matching the inserted leads");
});
