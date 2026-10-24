import db from '../../backend/src/config/db.js';
import { test, describe } from 'node:test';
import assert from 'node:assert';

describe('lead_campaigns helpers in MOCK mode', async () => {
  test('addLeadToCampaign is idempotent', async () => {
    db.mockDb.leadCampaigns = [];
    db.mockDb.leads = [
      { id: 'lead1', tenant_id: 'tenant1' }
    ];
    await db.addLeadToCampaign('tenant1', 'lead1', 'camp1');
    assert.strictEqual(db.mockDb.leadCampaigns.length, 1);
    
    // Add again
    await db.addLeadToCampaign('tenant1', 'lead1', 'camp1');
    assert.strictEqual(db.mockDb.leadCampaigns.length, 1);
  });

  test('getLeadsForCampaign returns only non-removed rows', async () => {
    db.mockDb.leadCampaigns = [];
    db.mockDb.leads = [
      { id: 'lead1', tenant_id: 'tenant1' },
      { id: 'lead2', tenant_id: 'tenant1' }
    ];
    await db.addLeadToCampaign('tenant1', 'lead1', 'camp1');
    await db.addLeadToCampaign('tenant1', 'lead2', 'camp1');
    
    let leads = await db.getLeadsForCampaign('tenant1', 'camp1');
    assert.strictEqual(leads.length, 2);

    await db.removeLeadFromCampaign('tenant1', 'lead2', 'camp1');
    leads = await db.getLeadsForCampaign('tenant1', 'camp1');
    assert.strictEqual(leads.length, 1);
    assert.strictEqual(leads[0].id, 'lead1');
  });
});
