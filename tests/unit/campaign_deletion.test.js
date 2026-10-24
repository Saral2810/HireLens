import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert';
import db from '../../backend/src/config/db.js';

describe('Campaign Deletion & Soft Deletion Suite', () => {
  const TENANT_ID = 'tenant_del_test';

  beforeEach(() => {
    db.mockDb.campaigns = [];
    db.mockDb.leads = [];
    db.mockDb.leadCampaigns = [];
    db.mockDb.agentBriefs = [];
    db.mockDb.callSessions = [];
    db.mockDb.callEvents = [];
  });

  test('Campaign Hard Deletion: Purges associated leads and updates junction', async () => {
    const campaignId = 'camp_001';
    const campaignName = 'Summer Growth 2026';

    db.mockDb.campaigns.push({
      id: campaignId,
      tenant_id: TENANT_ID,
      name: campaignName,
      status: 'active',
      created_at: new Date().toISOString()
    });

    // Create 500 leads attached to this campaign
    const leads = [];
    for (let i = 0; i < 500; i++) {
      const id = `lead_${i}`;
      leads.push({
        id,
        tenant_id: TENANT_ID,
        phone: `+1555000${String(i).padStart(4, '0')}`,
        campaign_name: campaignName,
        status: 'ingested',
        created_at: new Date().toISOString()
      });
      db.mockDb.leadCampaigns.push({
        id: `lc_${i}`,
        tenant_id: TENANT_ID,
        lead_id: id,
        campaign_id: campaignId,
        added_at: new Date().toISOString(),
        removed_at: null
      });
      // Add a dummy session
      db.mockDb.callSessions.push({
        id: `sess_${i}`,
        tenant_id: TENANT_ID,
        lead_id: id,
        campaign_id: campaignId
      });
    }
    db.mockDb.leads = leads;

    // Check pre-condition
    const preLeads = await db.getLeads(TENANT_ID);
    assert.strictEqual(preLeads.length, 500);

    const preCamps = await db.getCampaigns(TENANT_ID);
    assert.strictEqual(preCamps.length, 1);

    // Perform hard deletion
    const result = await db.deleteCampaign(TENANT_ID, campaignName);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedCount, 500);
    assert.strictEqual(result.updatedCount, 0);

    // Verify leads are completely purged from getLeads
    const postLeads = await db.getLeads(TENANT_ID);
    assert.strictEqual(postLeads.length, 0, 'Leads should be purged from getLeads');

    // Verify campaigns list no longer shows the campaign
    const postCamps = await db.getCampaigns(TENANT_ID);
    assert.strictEqual(postCamps.length, 0, 'Campaign should be removed from getCampaigns');

    // Verify child tables were cleaned up
    assert.strictEqual(db.mockDb.callSessions.length, 0, 'Call sessions should be cleared');
    assert.strictEqual(db.mockDb.leadCampaigns.length, 0, 'Junction entries should be cleared');
  });

  test('Campaign Soft Deletion: Sets status="deleted" and removed_at on junction', async () => {
    const campaignId = 'camp_soft_001';
    const campaignName = 'Winter Flash Sale';

    db.mockDb.campaigns.push({
      id: campaignId,
      tenant_id: TENANT_ID,
      name: campaignName,
      status: 'active',
      created_at: new Date().toISOString()
    });

    const leadId = 'lead_soft_1';
    db.mockDb.leads.push({
      id: leadId,
      tenant_id: TENANT_ID,
      phone: '+15559998888',
      campaign_name: campaignName,
      status: 'ingested',
      created_at: new Date().toISOString()
    });

    db.mockDb.leadCampaigns.push({
      id: 'lc_soft_1',
      tenant_id: TENANT_ID,
      lead_id: leadId,
      campaign_id: campaignId,
      added_at: new Date().toISOString(),
      removed_at: null
    });

    // Execute soft deletion
    const result = await db.deleteCampaign(TENANT_ID, campaignName, { softDelete: true });
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.softDeleted, true);

    // getLeads should exclude soft-deleted leads by default
    const activeLeads = await db.getLeads(TENANT_ID);
    assert.strictEqual(activeLeads.length, 0, 'Soft-deleted leads must not appear in active leads feed');

    // getLeads with includeDeleted: true should show the lead
    const allLeads = await db.getLeads(TENANT_ID, { includeDeleted: true });
    assert.strictEqual(allLeads.length, 1);
    assert.strictEqual(allLeads[0].status, 'deleted');

    // getCampaigns should exclude soft-deleted campaign by default
    const activeCamps = await db.getCampaigns(TENANT_ID);
    assert.strictEqual(activeCamps.length, 0, 'Soft-deleted campaign must not appear in active campaigns');

    // Junction record should have removed_at timestamp set
    const lc = db.mockDb.leadCampaigns.find(l => l.lead_id === leadId);
    assert.ok(lc.removed_at !== null, 'removed_at should be set on soft-deleted junction record');
  });

  test('Multi-Campaign Lead Isolation: Deleting one campaign retains the lead in other campaigns', async () => {
    const camp1Name = 'Email Drip';
    const camp2Name = 'SMS Blast';

    db.mockDb.campaigns.push(
      { id: 'c1', tenant_id: TENANT_ID, name: camp1Name, status: 'active', created_at: new Date().toISOString() },
      { id: 'c2', tenant_id: TENANT_ID, name: camp2Name, status: 'active', created_at: new Date().toISOString() }
    );

    // Lead belongs to BOTH campaigns
    db.mockDb.leads.push({
      id: 'shared_lead',
      tenant_id: TENANT_ID,
      phone: '+15551234567',
      campaign_name: `${camp1Name}, ${camp2Name}`,
      status: 'ingested',
      created_at: new Date().toISOString()
    });

    db.mockDb.leadCampaigns.push(
      { id: 'lc_1', tenant_id: TENANT_ID, lead_id: 'shared_lead', campaign_id: 'c1', added_at: new Date().toISOString(), removed_at: null },
      { id: 'lc_2', tenant_id: TENANT_ID, lead_id: 'shared_lead', campaign_id: 'c2', added_at: new Date().toISOString(), removed_at: null }
    );

    // Delete camp1
    const result = await db.deleteCampaign(TENANT_ID, camp1Name);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedCount, 0, 'Shared lead should NOT be deleted');
    assert.strictEqual(result.updatedCount, 1, 'Shared lead should be updated');

    // Verify lead still exists in getLeads
    const leads = await db.getLeads(TENANT_ID);
    assert.strictEqual(leads.length, 1);
    assert.strictEqual(leads[0].id, 'shared_lead');
    assert.strictEqual(leads[0].campaign_name, camp2Name, 'campaign_name should now only contain SMS Blast');

    // Verify camp1 removed from getCampaigns, camp2 remains
    const camps = await db.getCampaigns(TENANT_ID);
    assert.strictEqual(camps.length, 1);
    assert.strictEqual(camps[0].name, camp2Name);
  });

  test('Case-Insensitive and UUID identifier matching for campaign deletion', async () => {
    const campUuid = '11111111-2222-3333-4444-555555555555';
    db.mockDb.campaigns.push({
      id: campUuid,
      tenant_id: TENANT_ID,
      name: 'Case Sensitive Test',
      status: 'active',
      created_at: new Date().toISOString()
    });

    db.mockDb.leads.push({
      id: 'lead_case_1',
      tenant_id: TENANT_ID,
      phone: '+15553334444',
      campaign_name: 'case sensitive test', // lower-case
      status: 'ingested',
      created_at: new Date().toISOString()
    });

    // Delete using UUID
    const result = await db.deleteCampaign(TENANT_ID, campUuid);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.deletedCount, 1);

    const leads = await db.getLeads(TENANT_ID);
    assert.strictEqual(leads.length, 0);
  });

  test('REST API: DELETE /leads/campaigns deletes campaign and returns metadata', async () => {
    const { default: http } = await import('http');
    const { default: app } = await import('../../backend/src/app.js');

    const campName = 'API Leads Delete Test';
    db.mockDb.campaigns.push({
      id: 'camp_api_1',
      tenant_id: TENANT_ID,
      name: campName,
      status: 'active',
      created_at: new Date().toISOString()
    });

    db.mockDb.leads.push({
      id: 'lead_api_1',
      tenant_id: TENANT_ID,
      phone: '+15554445555',
      campaign_name: campName,
      status: 'ingested',
      created_at: new Date().toISOString()
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/leads/campaigns`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenant_id: TENANT_ID,
          campaign_name: campName
        })
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.deletedCount, 1);

      const remainingLeads = await db.getLeads(TENANT_ID);
      assert.strictEqual(remainingLeads.length, 0);
    } finally {
      server.close();
    }
  });

  test('REST API: DELETE /campaigns/:id deletes campaign and its leads', async () => {
    const { default: http } = await import('http');
    const { default: app } = await import('../../backend/src/app.js');

    const campId = 'camp_api_by_id';
    const campName = 'Direct Campaign Delete';
    db.mockDb.campaigns.push({
      id: campId,
      tenant_id: TENANT_ID,
      name: campName,
      status: 'active',
      created_at: new Date().toISOString()
    });

    db.mockDb.leads.push({
      id: 'lead_camp_id_1',
      tenant_id: TENANT_ID,
      phone: '+15556667777',
      campaign_name: campName,
      status: 'ingested',
      created_at: new Date().toISOString()
    });

    const server = http.createServer(app);
    await new Promise(resolve => server.listen(0, resolve));
    const port = server.address().port;

    try {
      const res = await fetch(`http://localhost:${port}/campaigns/${campId}?tenant_id=${TENANT_ID}`, {
        method: 'DELETE'
      });

      assert.strictEqual(res.status, 200);
      const data = await res.json();
      assert.strictEqual(data.success, true);
      assert.strictEqual(data.deletedCount, 1);

      const remainingLeads = await db.getLeads(TENANT_ID);
      assert.strictEqual(remainingLeads.length, 0);
    } finally {
      server.close();
    }
  });
});

