import test from 'node:test';
import assert from 'node:assert';

test('Batch Dialer & Campaign Resolution Logic', async (t) => {
  await t.test('Campaign name normalization matches encoded and spaced variants', () => {
    const campaigns = [
      { id: 'camp-1', name: 'Demo Test Leads ( 2 )' },
      { id: 'camp-2', name: 'Demo Test Leads (Ten)' },
      { id: 'camp-3', name: 'HDFC Credit Cards' }
    ];

    const testInputs = [
      'Demo%20Test%20Leads%20(%202%20)',
      'Demo Test Leads ( 2 )',
      'Demo Test Leads (2)',
      'Demo%20Test%20Leads%20(Ten)',
      'camp-2'
    ];

    for (const input of testInputs) {
      const decoded = decodeURIComponent(input).trim().toLowerCase();
      const match = campaigns.find(c =>
        c.id === input ||
        c.name.toLowerCase() === decoded ||
        c.name.toLowerCase().replace(/\s+/g, '') === decoded.replace(/\s+/g, '')
      );
      assert.ok(match, `Failed to match campaign for input: ${input}`);
    }
  });

  await t.test('Lead campaign filter matches comma-separated and whitespace variants', () => {
    const leads = [
      { id: 'lead-1', campaign_name: 'Demo Test Leads (Ten)', phone: '7001835922', score: 85, status: 'queued' },
      { id: 'lead-2', campaign_name: 'Demo Test Leads (Ten) , OtherCampaign', phone: '9960697048', score: 45, status: 'called' },
      { id: 'lead-3', campaign_name: 'Demo Test Leads ( 2 )', phone: '8824064557', score: 90, status: 'won' },
      { id: 'lead-4', campaign_name: 'HDFC Credit Cards', phone: '7710171313', score: 60, status: 'queued' }
    ];

    const targetName = 'Demo Test Leads (Ten)'.toLowerCase();
    const normalizedTarget = decodeURIComponent('Demo%20Test%20Leads%20(Ten)').trim().toLowerCase();

    const campaignLeads = leads.filter(l => {
      if (!l.campaign_name) return false;
      const list = l.campaign_name.split(',').map(c => c.trim().toLowerCase());
      return list.some(c =>
        c === targetName ||
        c === normalizedTarget ||
        c.replace(/\s+/g, '') === targetName.replace(/\s+/g, '') ||
        c.replace(/\s+/g, '') === normalizedTarget.replace(/\s+/g, '')
      );
    });

    assert.strictEqual(campaignLeads.length, 2);
    assert.strictEqual(campaignLeads[0].id, 'lead-1');
    assert.strictEqual(campaignLeads[1].id, 'lead-2');

    // Terminal statuses (won, dnc) should be skipped from re-dialing
    const eligibleLeads = campaignLeads.filter(l => !['dnc', 'won'].includes(l.status));
    assert.strictEqual(eligibleLeads.length, 2); // both lead-1 and lead-2 are eligible
  });

  await t.test('Slot release simulation on call completion', () => {
    let globalActive = 3;
    const releasedSlots = [];

    const fnReleaseSlot = (callId) => {
      releasedSlots.push(callId);
      if (globalActive > 0) globalActive--;
      return { success: true, global_active: globalActive };
    };

    // Simulate 3 concurrent calls completing
    fnReleaseSlot('call_1');
    fnReleaseSlot('call_2');
    fnReleaseSlot('call_3');

    assert.strictEqual(releasedSlots.length, 3);
    assert.strictEqual(globalActive, 0);
  });

  await t.test('Preserves lead intent scores when resetting for batch dial', () => {
    const rawData = { intent: 'high', attempts: 2, next_retry_at: '2026-09-08T00:00:00Z' };
    const updatedRaw = {
      ...rawData,
      attempts: 0,
      voice_agent_id: 'agent_demo_test'
    };
    delete updatedRaw.next_retry_at;

    assert.strictEqual(updatedRaw.intent, 'high');
    assert.strictEqual(updatedRaw.attempts, 0);
    assert.strictEqual(updatedRaw.voice_agent_id, 'agent_demo_test');
    assert.strictEqual(updatedRaw.next_retry_at, undefined);
  });
});
