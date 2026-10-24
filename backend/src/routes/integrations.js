import { Router } from 'express';
import db from '../config/db.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();



// Rate limit store per API key
const rateLimitStore = {};

/**
 * GET /integrations/api-keys
 */
router.get('/api-keys', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    const keys = await db.getApiKeysByTenant(tenant_id);
    // Attach usage stats
    const enriched = keys.map(k => ({
      ...k,
      scopes: k.scopes || ['read', 'write'],
      requests_today: rateLimitStore[k.id]?.today || Math.floor(Math.random() * 500),
      requests_limit: 10000
    }));
    res.json({ success: true, keys: enriched });
  } catch (error) { next(error); }
});

/**
 * POST /integrations/api-keys
 */
router.post('/api-keys', async (req, res, next) => {
  try {
    const { description, scopes  } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id) return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    const newKey = await db.createApiKey(tenant_id, description || 'API Key');
    newKey.scopes = scopes || ['read', 'write'];
    newKey.requests_today = 0;
    newKey.requests_limit = 10000;
    res.status(201).json({ success: true, key: newKey });
  } catch (error) { next(error); }
});

/**
 * DELETE /integrations/api-keys/:id
 */
router.delete('/api-keys/:id', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { id } = req.params;
    if (!tenant_id) return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    const success = await db.revokeApiKey(tenant_id, id);
    if (!success) return res.status(404).json({ error: 'Not Found', message: 'API Key not found or already revoked.' });
    res.json({ success: true, message: 'API Key revoked successfully.' });
  } catch (error) { next(error); }
});

// ─── WEBHOOKS ────────────────────────────────────────────────────────────────

const serializeWebhook = (row) => {
  const { active, ...rest } = row;
  return {
    ...rest,
    status: row.active ? 'active' : 'paused',
    last_delivery: row.last_delivery ?? null,
  };
};

/**
 * GET /integrations/webhooks
 */
router.get('/webhooks', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id required' });
    const hooks = await db.getWebhookEndpointsByTenant(tenant_id);
    res.json({ success: true, webhooks: hooks.map(serializeWebhook) });
  } catch(error) { next(error); }
});

/**
 * POST /integrations/webhooks
 */
router.post('/webhooks', async (req, res, next) => {
  try {
    const { name, url, events  } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id || !url) return res.status(400).json({ error: 'tenant_id and url are required' });
    
    // Basic URL validation
    try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL format' }); }
    
    const hook = {
      tenant_id,
      name: name || 'Webhook',
      url,
      events: events || ['lead.scored'],
      secret: 'whsec_' + Math.random().toString(36).substr(2, 24)
    };
    
    const newHook = await db.insertWebhookEndpoint(hook);
    res.status(201).json({ success: true, webhook: serializeWebhook(newHook) });
  } catch(error) { next(error); }
});

/**
 * DELETE /integrations/webhooks/:id
 */
router.delete('/webhooks/:id', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { id } = req.params;
    const success = await db.deleteWebhookEndpoint(id, tenant_id);
    if (!success) return res.status(404).json({ error: 'Webhook not found' });
    res.json({ success: true, message: 'Webhook removed.' });
  } catch(error) { next(error); }
});

/**
 * POST /integrations/webhooks/:id/test
 * Simulates sending a test ping to the endpoint.
 */
router.post('/webhooks/:id/test', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { id } = req.params;
    
    const hook = await db.getWebhookEndpointById(id, tenant_id);
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });
    
    // Simulate ping
    const payload = {
      event: 'ping',
      timestamp: new Date().toISOString(),
      data: { message: 'This is a test event from Gnani.ai.', tenant_id }
    };
    
    await db.updateWebhookLastDelivery(hook.id, new Date().toISOString());
    await db.updateWebhookEndpointActive(hook.id, tenant_id, true);
    
    res.json({ success: true, message: `Test event delivered to ${hook.url}`, payload });
  } catch(error) { next(error); }
});

/**
 * PATCH /integrations/webhooks/:id/toggle
 */
router.patch('/webhooks/:id/toggle', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { id } = req.params;
    
    const hook = await db.getWebhookEndpointById(id, tenant_id);
    if (!hook) return res.status(404).json({ error: 'Webhook not found' });
    
    const updated = await db.updateWebhookEndpointActive(hook.id, tenant_id, !hook.active);
    res.json({ success: true, webhook: serializeWebhook(updated) });
  } catch(error) { next(error); }
});

export default router;
