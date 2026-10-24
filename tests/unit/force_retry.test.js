import test from 'node:test';
import assert from 'node:assert';

// Set offline mode for tests before any imports
process.env.TEST_RUNNER = 'true';
process.env.SUPABASE_URL = 'http://localhost:54321';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-key';

import { forceRetry } from '../../backend/src/services/queueService.js';
import db from '../../backend/src/config/db.js';

test('forceRetry - only re-queues leads with a latest session not in connectedDispositions', async (t) => {
  const originalGetLeads = db.getLeads;
  const originalGetSessions = db.getCallSessionsByLeadId;
  const originalUpdate = db.updateLeadStatusAndData;
  const originalEnqueue = db.enqueueToDialer;
  const originalAudit = db.insertAuditLog;
  const originalSupabase = db.supabase;

  const updateCalls = [];
  const enqueueCalls = [];

  db.updateLeadStatusAndData = async (leadId, status, data) => {
    updateCalls.push({ leadId, status, data });
  };
  db.enqueueToDialer = async (tenantId, leadId, phone, campaignName) => {
    enqueueCalls.push({ tenantId, leadId, phone, campaignName });
  };
  db.insertAuditLog = async () => {};

  // Disable db.supabase to force mock branch
  db.supabase = null;

  try {
    // 4 Leads, all with status='called' (since they were dialed)
    const mockLeads = [
      { id: 'lead-1', tenant_id: 't1', status: 'called', phone: '111', campaign_name: 'camp' },
      { id: 'lead-2', tenant_id: 't1', status: 'called', phone: '222', campaign_name: 'camp' },
      { id: 'lead-3', tenant_id: 't1', status: 'called', phone: '333', campaign_name: 'camp' },
      { id: 'lead-4', tenant_id: 't1', status: 'called', phone: '444', campaign_name: 'camp' }
    ];

    db.getLeads = async () => mockLeads;

    db.getCallSessionsByLeadId = async (leadId) => {
      switch (leadId) {
        case 'lead-1':
          return [{ lead_id: 'lead-1', disposition: 'completed', started_at: '2026-09-01' }]; // connected
        case 'lead-2':
          return [{ lead_id: 'lead-2', disposition: 'user_busy', started_at: '2026-09-01' }]; // failed
        case 'lead-3':
          return [{ lead_id: 'lead-3', disposition: 'no_answer', started_at: '2026-09-01' }]; // failed
        case 'lead-4':
          return []; // zero sessions
        default:
          return [];
      }
    };

    const count = await forceRetry('t1');

    assert.strictEqual(count, 2);
    assert.strictEqual(updateCalls.length, 2);

    const updatedLeadIds = updateCalls.map(c => c.leadId);
    assert.ok(updatedLeadIds.includes('lead-2'), 'Should re-queue lead-2');
    assert.ok(updatedLeadIds.includes('lead-3'), 'Should re-queue lead-3');
    assert.ok(!updatedLeadIds.includes('lead-1'), 'Should NOT re-queue lead-1 (connected)');
    assert.ok(!updatedLeadIds.includes('lead-4'), 'Should NOT re-queue lead-4 (no sessions)');
  } finally {
    db.getLeads = originalGetLeads;
    db.getCallSessionsByLeadId = originalGetSessions;
    db.updateLeadStatusAndData = originalUpdate;
    db.enqueueToDialer = originalEnqueue;
    db.insertAuditLog = originalAudit;
    db.supabase = originalSupabase;
  }
});
