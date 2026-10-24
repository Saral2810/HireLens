import test from 'node:test';
import assert from 'node:assert';
import db from '../../backend/src/config/db.js';
import { enqueueJob, processNextJob } from '../../backend/src/services/jobQueue.js';

test('Lead Ingestion Scale & Robustness (10,000+ Leads)', async (t) => {
  const tenantId = 'scale-10k-tenant';
  await db.clearDb();

  await t.test('1. Database batch methods smoothly handle 10,000 leads', async () => {
    // Generate 10,000 mock leads
    const largeBatch = [];
    for (let i = 0; i < 10000; i++) {
      largeBatch.push({
        tenant_id: tenantId,
        client_id: `cli_10k_${i}`,
        name: `Scale User ${i}`,
        phone: `918000${String(i).padStart(4, '0')}`,
        source: 'scale_csv',
        raw_data: {
          monthly_income: 50000 + (i % 50000),
          credit_score: 650 + (i % 200)
        }
      });
    }

    // A. Bulk insert 10,000 leads
    const inserted = await db.insertLeads(largeBatch);
    assert.strictEqual(inserted.length, 10000, 'All 10,000 leads should be inserted');

    // B. Bulk lookup 10,000 phones
    const samplePhones = largeBatch.map(l => l.phone);
    const found = await db.findLeadsByPhones(tenantId, samplePhones);
    assert.strictEqual(found.length, 10000, 'findLeadsByPhones should find all 10,000 leads');

    // C. Bulk DNC check on 10,000 phones
    await db.addDncNumber(tenantId, samplePhones[10]);
    await db.addDncNumber(tenantId, samplePhones[5000]);
    await db.addDncNumber(tenantId, samplePhones[9999]);

    const dncSet = await db.getDncNumbersBatch(tenantId, samplePhones);
    assert.strictEqual(dncSet.size, 3, 'Should find 3 DNC numbers in 10k batch');
    assert.ok(dncSet.has(samplePhones[10]));
    assert.ok(dncSet.has(samplePhones[5000]));
    assert.ok(dncSet.has(samplePhones[9999]));

    // D. Bulk link 10,000 leads to a campaign
    const campaign = await db.insertCampaign({
      tenant_id: tenantId,
      name: 'Mega 10K Campaign',
      status: 'draft',
      total_leads: 10000
    });
    const leadIds = inserted.map(l => l.id);
    await db.addLeadsToCampaign(tenantId, leadIds, campaign.id);

    // E. Retrieve leads for campaign (verifying >1,000 pagination support)
    const linkedLeads = await db.getLeadsForCampaign(tenantId, campaign.id);
    assert.strictEqual(linkedLeads.length, 10000, 'All 10,000 leads should be linked to campaign');

    // F. Retrieve tenant leads (verifying >1,000 pagination support)
    const tenantLeads = await db.getLeads(tenantId);
    assert.strictEqual(tenantLeads.length, 10000, 'getLeads should return all 10,000 leads');
  });

  await t.test('2. End-to-end background batch job ingests 10,000 leads smoothly', async () => {
    await db.clearDb();

    // Create 1 existing lead to verify append logic
    const existingPhone = '9800000001';
    await db.insertLead({
      tenant_id: tenantId,
      name: 'Pre-existing Lead',
      phone: existingPhone,
      source: 'organic',
      client_id: 'exist-10k-1'
    });

    // Mark 2 numbers as DNC
    const dncPhone1 = '9800000100';
    const dncPhone2 = '9800009500';
    await db.addDncNumber(tenantId, dncPhone1);
    await db.addDncNumber(tenantId, dncPhone2);

    // Generate 10,000 leads in batch payload
    const batchPayload = [];
    batchPayload.push({
      client_id: 'dup-10k-1',
      name: 'Updated Lead',
      phone: existingPhone,
      source: 'csv_upload'
    });

    for (let i = 2; i <= 10000; i++) {
      batchPayload.push({
        client_id: `cli_${i}`,
        name: `Batch 10k User ${i}`,
        phone: `98000${String(i).padStart(5, '0')}`,
        email: i % 10 === 0 ? `user${i}@example.com` : null,
        source: 'csv_upload',
        raw_data: {
          monthly_income: 45000 + (i % 20000),
          age: 25 + (i % 35)
        }
      });
    }

    const campaign = await db.insertCampaign({
      tenant_id: tenantId,
      name: 'Enterprise 10K Ingestion Campaign',
      status: 'ingesting',
      total_leads: batchPayload.length
    });

    const job = await enqueueJob(tenantId, 'batch_ingest', {
      tenant_id: tenantId,
      leads: batchPayload,
      dataset_id: 'enterprise-10k-dataset',
      campaign_name: 'Enterprise 10K Ingestion Campaign',
      campaign_id: campaign.id
    });

    assert.ok(job.id, 'Job should be enqueued successfully');

    // Process the background ingestion job
    const startTime = Date.now();
    await processNextJob();
    const durationMs = Date.now() - startTime;
    console.log(`[Test] 10,000 lead batch ingestion finished in ${durationMs}ms`);

    // Verify campaign status was updated to draft
    const updatedCampaign = (await db.getCampaigns(tenantId)).find(c => c.id === campaign.id);
    assert.ok(updatedCampaign, 'Campaign must exist');
    assert.strictEqual(updatedCampaign.status, 'draft', 'Campaign status should transition to draft after ingestion');
    assert.strictEqual(updatedCampaign.processed_leads, 10000, 'All 10,000 leads should be processed');

    // Verify DNC tagging on sample DNC leads
    const dncLead1 = await db.findLeadByPhone(tenantId, dncPhone1);
    assert.ok(dncLead1, 'DNC lead 1 must exist');
    assert.strictEqual(dncLead1.status, 'dnc', 'Lead with DNC phone must have status dnc');

    const dncLead2 = await db.findLeadByPhone(tenantId, dncPhone2);
    assert.ok(dncLead2, 'DNC lead 2 must exist');
    assert.strictEqual(dncLead2.status, 'dnc', 'Lead with DNC phone must have status dnc');

    // Verify existing duplicate was appended
    const existing = await db.findLeadByPhone(tenantId, existingPhone);
    assert.ok(existing, 'Existing lead must exist');
    assert.strictEqual(existing.campaign_name, 'Enterprise 10K Ingestion Campaign');
  });

  await t.test('3. RFC 4180 CSV parsing handles commas, quotes, and newlines at scale', () => {
    // Parser test
    function parseCsvText(text) {
      const rows = [];
      let currentRow = [];
      let currentField = '';
      let insideQuote = false;
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const nextChar = text[i + 1];
        if (char === '"') {
          if (insideQuote && nextChar === '"') {
            currentField += '"';
            i++;
          } else {
            insideQuote = !insideQuote;
          }
        } else if (char === ',' && !insideQuote) {
          currentRow.push(currentField.trim());
          currentField = '';
        } else if ((char === '\r' || char === '\n') && !insideQuote) {
          if (char === '\r' && nextChar === '\n') {
            i++;
          }
          currentRow.push(currentField.trim());
          currentField = '';
          if (currentRow.some(field => field.length > 0)) {
            rows.push(currentRow);
          }
          currentRow = [];
        } else {
          currentField += char;
        }
      }
      if (currentField.length > 0 || currentRow.length > 0) {
        currentRow.push(currentField.trim());
        if (currentRow.some(field => field.length > 0)) {
          rows.push(currentRow);
        }
      }
      return rows;
    }

    const testCsv = `Name,Phone,Address,Notes\n"Sen, Rahul",9999911111,"Flat 101, Lake View Apt","Prefers morning calls"\n"Gupta, ""Aman""",9999922222,"Plot 4, Sector 15","High intent"`;
    const parsed = parseCsvText(testCsv);
    assert.strictEqual(parsed.length, 3);
    assert.strictEqual(parsed[1][0], 'Sen, Rahul', 'Should preserve comma inside quote');
    assert.strictEqual(parsed[1][2], 'Flat 101, Lake View Apt', 'Should preserve address with comma');
    assert.strictEqual(parsed[2][0], 'Gupta, "Aman"', 'Should handle escaped quotes');

    // Scale test: 10,000 rows
    const scaleLines = ['name,phone,email,income'];
    for (let i = 0; i < 10000; i++) {
      scaleLines.push(`"User, Number ${i}",+919876543210,user${i}@example.com,${50000 + i}`);
    }
    const bigCsvText = scaleLines.join('\n');
    const startParse = Date.now();
    const bigParsed = parseCsvText(bigCsvText);
    const parseTime = Date.now() - startParse;
    console.log(`[Test] 10,000 line CSV parsed in ${parseTime}ms`);
    assert.strictEqual(bigParsed.length, 10001);
    assert.strictEqual(bigParsed[1][0], 'User, Number 0');
    assert.ok(parseTime < 2000, '10,000 row CSV parsing must be fast (<2s)');
  });
});
