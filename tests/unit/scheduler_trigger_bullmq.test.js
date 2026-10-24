import test from 'node:test';
import assert from 'node:assert/strict';
import schedulerService from '../../backend/src/services/schedulerService.js';
import { campaignQueue } from '../../backend/src/services/queue/campaignQueue.js';

test('schedulerService.triggerJobNow (BullMQ Fallback)', async (t) => {
  await t.test('should fallback to BullMQ, find the job, and enqueue it immediately with matching tenantId', async () => {
    const originalGetRepeatableJobs = campaignQueue.getRepeatableJobs;
    const originalAdd = campaignQueue.add;
    
    let addedArgs = null;
    campaignQueue.getRepeatableJobs = async () => [
      { id: 'recurring-crm_sync-tenantA-123', key: 'repeat-*-jobId', name: 'crm-sync', cron: '0 0 * * *' }
    ];
    campaignQueue.add = async (name, data, opts) => {
      addedArgs = { name, data, opts };
      return { id: 'new-job-123' };
    };

    try {
      await schedulerService.init();
      schedulerService.jobs = [];

      const result = await schedulerService.triggerJobNow('recurring-crm_sync-tenantA-123', 'tenantA');

      assert.deepStrictEqual(result, { success: true, triggered: 'bullmq', jobId: 'new-job-123' });
      assert.strictEqual(addedArgs.name, 'crm-sync');
      assert.deepStrictEqual(addedArgs.data, {
        campaignId: 'recurring-crm_sync-tenantA-123',
        tenantId: 'tenantA',
        metaData: null,
        isManualTrigger: true
      });
      assert.deepStrictEqual(addedArgs.opts, { removeOnComplete: true });
    } finally {
      campaignQueue.getRepeatableJobs = originalGetRepeatableJobs;
      campaignQueue.add = originalAdd;
    }
  });

  await t.test('should throw tenant mismatch error when caller tenantId differs from job tenantId', async () => {
    const originalGetRepeatableJobs = campaignQueue.getRepeatableJobs;
    const originalAdd = campaignQueue.add;
    let addCalled = false;

    campaignQueue.getRepeatableJobs = async () => [
      { id: 'recurring-crm_sync-tenantA-123', key: 'repeat-*-jobId', name: 'crm-sync', cron: '0 0 * * *' }
    ];
    campaignQueue.add = async () => {
      addCalled = true;
      return { id: 'should-not-call' };
    };

    try {
      await schedulerService.init();
      schedulerService.jobs = [];

      await assert.rejects(
        async () => {
          await schedulerService.triggerJobNow('recurring-crm_sync-tenantA-123', 'tenantB');
        },
        {
          name: 'Error',
          message: 'Tenant mismatch: cannot trigger job for another tenant'
        }
      );

      assert.strictEqual(addCalled, false);
    } finally {
      campaignQueue.getRepeatableJobs = originalGetRepeatableJobs;
      campaignQueue.add = originalAdd;
    }
  });
});
