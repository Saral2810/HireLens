import test from 'node:test';
import assert from 'node:assert';
import schedulerService from '../../backend/src/services/schedulerService.js';
import db from '../../backend/src/config/db.js';

test.before(async () => {
  process.env.NODE_ENV = 'test';
  await db.clearDb();
  await schedulerService.init();
});

test.after(() => {
  schedulerService.stop();
});

test('1. Create one-time campaign dial scheduled job', async () => {
  const futureTime = new Date(Date.now() + 3600000).toISOString();
  const job = await schedulerService.createScheduledJob({
    tenantId: 'test-sched-tenant',
    type: 'campaign_dial',
    targetCampaign: 'Alpha Launch',
    scheduledAt: futureTime,
    payload: { whatsapp_threshold: 80, max_concurrency: 4 }
  });

  assert.ok(job.id, 'Job should have an ID');
  assert.strictEqual(job.type, 'campaign_dial');
  assert.strictEqual(job.target_campaign, 'Alpha Launch');
  assert.strictEqual(job.status, 'scheduled');
  assert.strictEqual(job.scheduled_at, futureTime);

  const jobs = await schedulerService.getScheduledJobs('test-sched-tenant');
  const found = jobs.find(j => j.id === job.id);
  assert.ok(found, 'Should find created job in tenant list');
});

test('2. Create recurring CRM sync cron job', async () => {
  const job = await schedulerService.createScheduledJob({
    tenantId: 'test-sched-tenant',
    type: 'crm_sync',
    name: 'Daily Morning CRM Sync',
    cronExpression: '0 9 * * *'
  });

  assert.ok(job.id);
  assert.strictEqual(job.cron_expression, '0 9 * * *');
  assert.strictEqual(job.status, 'scheduled');
});

test('3. Manually trigger a scheduled campaign dial job', async () => {
  // Setup mock leads for this campaign
  if (!db.mockDb.campaigns.find(c => c.name === 'Alpha Launch')) {
    db.mockDb.campaigns.push({ id: 'camp-alpha-2', tenant_id: 'test-sched-tenant', name: 'Alpha Launch' });
  }
  db.mockDb.leads.push(
    { id: 'lead-sched-1', tenant_id: 'test-sched-tenant', phone: '9988001122', campaign_name: 'Alpha Launch', status: 'ingested' },
    { id: 'lead-sched-2', tenant_id: 'test-sched-tenant', phone: '9988001133', campaign_name: 'Alpha Launch', status: 'called' }
  );

  const futureTime = new Date(Date.now() + 7200000).toISOString();
  const job = await schedulerService.createScheduledJob({
    tenantId: 'test-sched-tenant',
    type: 'campaign_dial',
    targetCampaign: 'Alpha Launch',
    scheduledAt: futureTime
  });

  const res = await schedulerService.triggerJobNow(job.id, 'test-sched-tenant');
  assert.strictEqual(res.success, true);
  assert.strictEqual(res.campaign, 'Alpha Launch');
  assert.ok(res.enqueued_count >= 1, 'Should enqueue campaign leads');

  const jobs = await schedulerService.getScheduledJobs('test-sched-tenant');
  const updatedJob = jobs.find(j => j.id === job.id);
  assert.strictEqual(updatedJob.status, 'completed');
  assert.ok(updatedJob.last_run, 'Should have last_run set');
});

test('4. Cancel and delete a scheduled job', async () => {
  const futureTime = new Date(Date.now() + 86400000).toISOString();
  const job = await schedulerService.createScheduledJob({
    tenantId: 'test-sched-tenant',
    type: 'ingestion',
    name: 'Temporary Ingestion',
    scheduledAt: futureTime
  });

  const cancelled = await schedulerService.cancelScheduledJob(job.id, 'test-sched-tenant');
  assert.strictEqual(cancelled, true);

  const jobs = await schedulerService.getScheduledJobs('test-sched-tenant');
  const found = jobs.find(j => j.id === job.id);
  assert.strictEqual(found, undefined, 'Job should no longer appear after cancellation');
});
