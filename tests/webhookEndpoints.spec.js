import test from 'node:test';
import assert from 'node:assert';
import db from '../backend/src/config/db.js';

test('Webhook Endpoints Persistence and Isolation', async (t) => {
  // Clear the DB to start fresh
  await db.clearDb();

  await t.test('1. Insert webhook config, list by tenant, verify only that tenant configs returned', async () => {
    await db.insertWebhookEndpoint({
      tenant_id: 'tenant-a',
      name: 'Tenant A Webhook',
      url: 'https://tenant-a.com/hook',
      events: ['lead.scored'],
      secret: 'secretA'
    });

    await db.insertWebhookEndpoint({
      tenant_id: 'tenant-b',
      name: 'Tenant B Webhook',
      url: 'https://tenant-b.com/hook',
      events: ['lead.scored'],
      secret: 'secretB'
    });

    const hooksA = await db.getWebhookEndpointsByTenant('tenant-a');
    assert.strictEqual(hooksA.length, 1);
    assert.strictEqual(hooksA[0].tenant_id, 'tenant-a');
    assert.strictEqual(hooksA[0].name, 'Tenant A Webhook');
    
    const hooksB = await db.getWebhookEndpointsByTenant('tenant-b');
    assert.strictEqual(hooksB.length, 1);
    assert.strictEqual(hooksB[0].tenant_id, 'tenant-b');
  });

  await t.test('2. Filter by event — only configs subscribed to the event should fire', async () => {
    await db.insertWebhookEndpoint({
      tenant_id: 'tenant-c',
      name: 'Lead Scored Only',
      url: 'https://tenant-c.com/scored',
      events: ['lead.scored'],
      secret: 'secretC1'
    });

    await db.insertWebhookEndpoint({
      tenant_id: 'tenant-c',
      name: 'Call Completed Only',
      url: 'https://tenant-c.com/call',
      events: ['call.completed'],
      secret: 'secretC2'
    });

    const scoredHooks = await db.getActiveWebhooksByEvent('tenant-c', 'lead.scored');
    assert.strictEqual(scoredHooks.length, 1);
    assert.strictEqual(scoredHooks[0].name, 'Lead Scored Only');

    const callHooks = await db.getActiveWebhooksByEvent('tenant-c', 'call.completed');
    assert.strictEqual(callHooks.length, 1);
    assert.strictEqual(callHooks[0].name, 'Call Completed Only');
    
    const bothHooks = await db.getActiveWebhooksByEvent('tenant-c', 'unknown.event');
    assert.strictEqual(bothHooks.length, 0);
  });

  await t.test('3. Cross-tenant isolation — tenant B cannot list/delete tenant As webhooks', async () => {
    const hookA = await db.insertWebhookEndpoint({
      tenant_id: 'tenant-a2',
      name: 'Secret Hook A',
      url: 'https://tenant-a2.com/hook',
      events: ['lead.scored'],
      secret: 'secretA2'
    });

    // Tenant B attempts to fetch Tenant A's hook by ID
    const fetchedByB = await db.getWebhookEndpointById(hookA.id, 'tenant-b2');
    assert.strictEqual(fetchedByB, null);

    // Tenant B attempts to delete Tenant A's hook
    const deletedByB = await db.deleteWebhookEndpoint(hookA.id, 'tenant-b2');
    assert.strictEqual(deletedByB, false);
    
    // Verify hook A is still there
    const fetchedByA = await db.getWebhookEndpointById(hookA.id, 'tenant-a2');
    assert.ok(fetchedByA !== null);
    assert.strictEqual(fetchedByA.name, 'Secret Hook A');
    
    // Tenant A deletes its own hook
    const deletedByA = await db.deleteWebhookEndpoint(hookA.id, 'tenant-a2');
    assert.strictEqual(deletedByA, true);
    
    const fetchedAfterDelete = await db.getWebhookEndpointById(hookA.id, 'tenant-a2');
    assert.strictEqual(fetchedAfterDelete, null);
  });
});
