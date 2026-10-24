import test from 'node:test';
import assert from 'node:assert';
import db from '../../backend/src/config/db.js';
import { enqueueJob, processNextJob } from '../../backend/src/services/jobQueue.js';

test('Bulk Ingestion (>5,000 leads) processes smoothly without timeouts or failures', async (t) => {
  const tenantId = 'bulk-test-tenant';
  await db.clearDb();

  await t.test('1. Bulk db helper methods handle arrays >5,000 items', async () => {
    // Generate 5,200 leads
    const largeLeads = [];
    for (let i = 0; i < 5200; i++) {
      largeLeads.push({
        tenant_id: tenantId,
        client_id: `bulk_lead_${i}`,
        name: `Bulk User ${i}`,
        phone: `910000${String(i).padStart(4, '0')}`,
        source: 'organic',
        raw_data: { age: 20 + (i % 40), income: 30000 + (i * 10) }
      });
    }

    // Test insertLeads bulk
    const inserted = await db.insertLeads(largeLeads);
    assert.strictEqual(inserted.length, 5200, 'All 5,200 leads should be inserted');

    // Test findLeadsByPhones bulk
    const queryPhones = largeLeads.slice(0, 5200).map(l => l.phone);
    const found = await db.findLeadsByPhones(tenantId, queryPhones);
    assert.strictEqual(found.length, 5200, 'findLeadsByPhones should find all 5,200 leads');

    // Test getDncNumbersBatch
    await db.addDncNumber(tenantId, queryPhones[0]);
    await db.addDncNumber(tenantId, queryPhones[500]);
    await db.addDncNumber(tenantId, queryPhones[5100]);

    const dncSet = await db.getDncNumbersBatch(tenantId, queryPhones);
    assert.strictEqual(dncSet.size, 3, 'Should find exactly 3 DNC numbers in batch');
    assert.ok(dncSet.has(queryPhones[0]));
    assert.ok(dncSet.has(queryPhones[500]));
    assert.ok(dncSet.has(queryPhones[5100]));

    // Test addLeadsToCampaign bulk
    const leadIds = inserted.map(l => l.id);
    const campaign = await db.insertCampaign({ tenant_id: tenantId, name: 'Mega Campaign', status: 'draft', total_leads: 5200 });
    await db.addLeadsToCampaign(tenantId, leadIds, campaign.id);

    const linked = await db.getLeadsForCampaign(tenantId, campaign.id);
    assert.strictEqual(linked.length, 5200, 'All 5,200 leads should be linked to campaign');
  });

  await t.test('2. End-to-end background batch job ingests 5,100 leads smoothly', async () => {
    await db.clearDb();

    // Create 1 existing lead to verify append/duplicate logic
    const existingPhone = '9999900001';
    await db.insertLead({
      tenant_id: tenantId,
      name: 'Existing Lead',
      phone: existingPhone,
      source: 'organic',
      client_id: 'exist-1'
    });

    // Mark 2 numbers as DNC
    const dncPhone1 = '9999900100';
    const dncPhone2 = '9999902500';
    await db.addDncNumber(tenantId, dncPhone1);
    await db.addDncNumber(tenantId, dncPhone2);

    // Create 5,100 leads in the batch:
    // - 1 is duplicate (existingPhone)
    // - 2 are DNC
    // - 4 have no client_id (one is generated for them)
    // - Rest are valid new leads
    const batchLeads = [];
    batchLeads.push({
      client_id: 'dup-1',
      name: 'Updated Lead',
      phone: existingPhone,
      source: 'batch'
    });

    for (let i = 2; i <= 5100; i++) {
      const phone = `99999${String(i).padStart(5, '0')}`;
      const hasClientId = i > 5; // First few have no client_id
      batchLeads.push({
        ...(hasClientId ? { client_id: `cli_${i}` } : {}),
        name: `Batch Lead ${i}`,
        phone,
        source: 'bulk_upload',
        raw_data: {
          monthly_income: 45000,
          age: 28
        }
      });
    }

    const campaign = await db.insertCampaign({
      tenant_id: tenantId,
      name: 'Batch 5000+ Campaign',
      status: 'ingesting',
      total_leads: batchLeads.length
    });

    const job = await enqueueJob(tenantId, 'batch_ingest', {
      tenant_id: tenantId,
      leads: batchLeads,
      dataset_id: 'test-5k-dataset',
      campaign_name: 'Batch 5000+ Campaign',
      campaign_id: campaign.id
    });

    assert.ok(job.id, 'Job should be successfully enqueued');

    // Process the job
    await processNextJob();

    // Verify campaign status was updated
    const updatedCampaign = (await db.getCampaigns(tenantId)).find(c => c.id === campaign.id);
    assert.ok(updatedCampaign);
    assert.strictEqual(updatedCampaign.status, 'draft', 'Campaign status should be draft when ingestion completes');
    assert.ok(updatedCampaign.processed_leads >= 5090, 'At least 5,090 leads should be processed');

    // Verify DNC leads were tagged with status='dnc'
    const leadDnc1 = await db.findLeadByPhone(tenantId, dncPhone1);
    assert.ok(leadDnc1);
    assert.strictEqual(leadDnc1.status, 'dnc', 'Lead with DNC phone should have status dnc');

    const leadDnc2 = await db.findLeadByPhone(tenantId, dncPhone2);
    assert.ok(leadDnc2);
    assert.strictEqual(leadDnc2.status, 'dnc', 'Lead with DNC phone should have status dnc');
  });
});
