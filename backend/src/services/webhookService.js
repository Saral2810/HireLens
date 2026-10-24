import db from '../config/db.js';

export async function dispatchWebhook(tenantId, eventName, payload) {
  try {
    const activeHooks = await db.getActiveWebhooksByEvent(tenantId, eventName);
    
    for (const hook of activeHooks) {
      try {
        const response = await fetch(hook.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: eventName,
            lead: payload,
            timestamp: new Date().toISOString()
          })
        });
        if (response.ok) {
          await db.updateWebhookLastDelivery(hook.id, new Date().toISOString());
          console.log(`[WebhookService] Successfully dispatched ${eventName} to ${hook.url}`);
        } else {
          console.error(`[WebhookService] Failed to dispatch to ${hook.url}. Status: ${response.status}`);
        }
      } catch (err) {
        console.error(`[WebhookService] Error dispatching to ${hook.url}:`, err.message);
      }
    }
  } catch(err) {
    console.error(`[WebhookService] Failed to fetch webhooks for ${tenantId}:`, err);
  }
}
