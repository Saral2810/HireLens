import test from 'node:test';
import assert from 'node:assert';
import db from '../../backend/src/config/db.js';
import { enqueueJob, processNextJob, resolveClientId } from '../../backend/src/services/jobQueue.js';

test('resolveClientId', async (t) => {
  await t.test('keeps an existing client_id', () => {
    assert.strictEqual(resolveClientId({ client_id: 'C-1' }), 'C-1');
  });

  await t.test('falls back to common HR ID columns, top-level or in raw_data', () => {
    assert.strictEqual(resolveClientId({ candidate_id: 42 }), '42');
    assert.strictEqual(resolveClientId({ raw_data: { application_id: ' APP-7 ' } }), 'APP-7');
  });

  await t.test('generates a cand_ ID when none is given', () => {
    const a = resolveClientId({ name: 'No Id' });
    const b = resolveClientId({ name: 'No Id' });
    assert.match(a, /^cand_[0-9a-f]{12}$/);
    assert.notStrictEqual(a, b);
  });
});

test('HR sheet without client_id is ingested with candidate fields', async () => {
  const tenantId = 'hr-bulk-tenant';
  await db.clearDb();

  const rows = [
    { name: 'asha rao', phone: '9876500001', source: 'hr_upload', raw_data: { 'Job Role': 'Backend Engineer', 'Notice Period': '2 months', 'Current CTC': '12,00,000' } },
    { name: 'Vikram', phone: '9876500002', source: 'hr_upload', candidate_id: 'CAND-77', raw_data: { 'Total Experience': '3 yrs' } }
  ];

  const campaign = await db.insertCampaign({ tenant_id: tenantId, name: 'HR Drive', status: 'ingesting', total_leads: rows.length });
  await enqueueJob(tenantId, 'batch_ingest', {
    tenant_id: tenantId,
    leads: rows,
    dataset_id: 'hr-sheet',
    campaign_name: 'HR Drive',
    campaign_id: campaign.id
  });
  await processNextJob();

  const asha = await db.findLeadByPhone(tenantId, '9876500001');
  assert.ok(asha, 'row without any ID should be ingested');
  assert.match(asha.client_id, /^cand_/);
  assert.strictEqual(asha.job_role, 'Backend Engineer');
  assert.strictEqual(asha.notice_period_days, 60);
  assert.strictEqual(asha.current_ctc, 1200000);
  assert.strictEqual(asha.screening_status, 'pending');

  const vikram = await db.findLeadByPhone(tenantId, '9876500002');
  assert.ok(vikram);
  assert.strictEqual(vikram.client_id, 'CAND-77');
  assert.strictEqual(vikram.experience_years, 3);
});
