/**
 * CRM hook (placeholder).
 *
 * The original CRM integrations (HubSpot / Salesforce / Zoho / LeadSquared) were removed.
 * These functions are kept so the rest of the framework (handoff, job queue) keeps working.
 * Plug your own CRM in here if you need one.
 */

export async function syncToCRM(tenantId, lead, provider) {
  return { success: true, skipped: true, reason: 'No CRM configured', tenant_id: tenantId, lead_id: lead?.id || null, provider: provider || null };
}

export async function getCRMLists(/* tenantId, provider */) {
  return [];
}

export async function getCRMContactsFromList(/* tenantId, provider, listId */) {
  return [];
}

export default { syncToCRM, getCRMLists, getCRMContactsFromList };
