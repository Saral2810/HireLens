import { randomUUID } from 'crypto';
import db from '../config/db.js';
import { validateLead, cleanPhone } from '../utils/validation.js';
import { computeLeadScore } from './scoringEngine.js';
import { syncToCRM } from './crmService.js';
import { enqueueLead } from './queueService.js';
import { sendSlackNotification } from './slackService.js';
import { dialAllCampaignLeads } from './campaignDialer.js';

let workerInterval = null;
let isProcessing = false;

// HR sheets rarely have a client_id column; use their own ID column if present, else generate one.
const CLIENT_ID_ALIASES = ['client_id', 'candidate_id', 'applicant_id', 'application_id', 'employee_id'];

/**
 * @param {object} item One uploaded row
 * @returns {string} The row's own ID (client_id or a common HR ID column), or a generated `cand_<hex>`
 */
export function resolveClientId(item) {
  for (const key of CLIENT_ID_ALIASES) {
    const value = item[key] ?? item.raw_data?.[key];
    if (value !== undefined && value !== null && String(value).trim() !== '') return String(value).trim();
  }
  return `cand_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/**
 * Process a batch ingestion job.
 */
async function processBatchIngest(job) {
  const { tenant_id, leads, dataset_id, campaign_name, campaign_id, custom_scoring_rules } = job.payload;
  
  const weights = await db.getWeights(tenant_id);
  if (custom_scoring_rules && Array.isArray(custom_scoring_rules)) {
      weights.custom_scoring_rules = custom_scoring_rules;
  }
  const campaigns = await db.getCampaigns(tenant_id);
  const campaign = campaigns.find(c => c.id === campaign_id);
  const voiceAgentId = campaign ? campaign.voice_agent_id : null;

  // Pre-validation pass (All-or-nothing)
  const validationErrors = [];
  const batchPhones = new Set();
  const leadsToProcess = [];

  for (let i = 0; i < leads.length; i++) {
    const item = leads[i];
    const leadPayload = { ...item, tenant_id };
    const clientId = resolveClientId(item);

    if (leadPayload.phone != null) {
      leadPayload.phone = cleanPhone(leadPayload.phone);
    }

    const val = validateLead(leadPayload);
    if (!val.isValid) {
      validationErrors.push({ index: i, errors: val.errors });
      continue;
    }

    const cleaned = cleanPhone(leadPayload.phone || item.phone);
    if (batchPhones.has(cleaned)) {
      validationErrors.push({ index: i, errors: ["Duplicate phone number within the batch"] });
      continue;
    }
    batchPhones.add(cleaned);

    leadPayload.phone = cleaned;
    leadPayload.dataset_id = dataset_id || 'batch-upload';
    leadPayload.campaign_name = campaign_name || 'Batch Campaigns';
    leadPayload.client_id = clientId;
    
    leadsToProcess.push({ index: i, payload: leadPayload });
  }

  // We no longer fail the entire batch. We just skip invalid leads.
  if (validationErrors.length === leads.length && leads.length > 0) {
    if (campaign_id) {
      await db.updateCampaign(campaign_id, {
        status: 'failed',
        failed_leads: leads.length
      });
    }
    return {
      success: false,
      error: 'All leads failed validation',
      details: validationErrors
    };
  }

  let accepted = 0;
  let appended = 0;
  const details = [];
  const CHUNK_SIZE = 1000;

  // Throttled CRM sync pool helper
  const throttledSyncToCRM = async (tenantId, leadsToSync, provider = process.env.CRM_PROVIDER || null, concurrency = 5) => {
    if (!leadsToSync || leadsToSync.length === 0) return;
    const pool = [...leadsToSync];
    const workers = Array.from({ length: Math.min(concurrency, pool.length) }, async () => {
      while (pool.length > 0) {
        const lead = pool.shift();
        try {
          await syncToCRM(tenantId, lead, provider);
        } catch (err) {
          console.error('[Ingestion Sync-Back] Failed to sync to CRM for lead', lead?.id, err?.message || err);
        }
      }
    });
    await Promise.all(workers);
  };

  // Resolve target campaign for junction linking
  let targetCampaign = campaign || null;
  if (!targetCampaign && campaign_name) {
    targetCampaign = campaigns.find(c => c.name.toLowerCase() === campaign_name.toLowerCase());
    if (!targetCampaign) {
      targetCampaign = await db.insertCampaign({ tenant_id, name: campaign_name, status: 'ingesting', total_leads: leads.length });
    }
  }

  for (let c = 0; c < leadsToProcess.length; c += CHUNK_SIZE) {
    const chunk = leadsToProcess.slice(c, c + CHUNK_SIZE);
    const chunkPhones = chunk.map(item => item.payload.phone);
    const crmSyncBatch = [];

    // 1. Bulk lookup of existing leads
    let existingByPhone = new Map();
    try {
      const existingLeadsList = await db.findLeadsByPhones(tenant_id, chunkPhones);
      existingByPhone = new Map((existingLeadsList || []).map(l => [l.phone, l]));
    } catch (lookupErr) {
      console.error('[JobQueue] Bulk duplicate lookup error, continuing with fallback:', lookupErr);
    }

    // 2. Bulk lookup of DNC registry
    let dncSet = new Set();
    try {
      dncSet = await db.getDncNumbersBatch(tenant_id, chunkPhones);
    } catch (dncErr) {
      console.error('[JobQueue] Bulk DNC lookup error, continuing:', dncErr);
    }

    const newLeadsToInsert = [];
    const newLeadsMeta = [];
    const existingToUpdate = [];
    const existingLeadIdsToLink = [];

    for (const { index, payload } of chunk) {
      try {
        const existing = existingByPhone.get(payload.phone);
        if (existing) {
          const newCampaign = campaign_name || 'Batch Campaigns';
          
          existing.raw_data = existing.raw_data || {};
          if (!existing.raw_data.platform_lead_id) {
            existing.raw_data.platform_lead_id = payload.raw_data?.platform_lead_id || 'lead_' + Math.random().toString(36).substr(2, 9);
          }
          
          const mostRecentCampaignId = payload.raw_data?.campaign_id || 'cmp_' + Math.random().toString(36).substr(2, 9);
          existing.raw_data.campaign_id = mostRecentCampaignId;

          existingToUpdate.push({
            id: existing.id,
            newCampaign,
            raw_data: existing.raw_data,
            existing,
            index,
            phone: payload.phone
          });
          existingLeadIdsToLink.push(existing.id);

          if (existing.raw_data?.crm_id || existing.email) {
            crmSyncBatch.push(existing);
          }
          continue;
        }

        payload.assigned_agent_id = voiceAgentId;
        const score = await computeLeadScore(payload, weights);
        payload.score = score;

        payload.raw_data = payload.raw_data || {};
        if (!payload.raw_data.platform_lead_id) {
          payload.raw_data.platform_lead_id = 'lead_' + Math.random().toString(36).substr(2, 9);
        }
        if (!payload.raw_data.campaign_id) {
          payload.raw_data.campaign_id = 'cmp_' + Math.random().toString(36).substr(2, 9);
        }

        const isDnc = dncSet.has(payload.phone);
        if (isDnc) {
          payload.status = 'dnc';
        }

        newLeadsToInsert.push(payload);
        newLeadsMeta.push({ index, phone: payload.phone, isDnc, score });
      } catch (leadPrepErr) {
        console.error('[JobQueue] Error preparing lead in batch:', leadPrepErr);
      }
    }

    // Concurrent batch update for existing leads
    const CONCURRENCY = 20;
    for (let i = 0; i < existingToUpdate.length; i += CONCURRENCY) {
      const slice = existingToUpdate.slice(i, i + CONCURRENCY);
      await Promise.all(slice.map(async item => {
        try {
          await db.updateLeadCampaignAndData(item.id, item.newCampaign, item.raw_data);
          appended++;
          details.push({ index: item.index, phone: item.phone, status: 'appended', lead_id: item.id });

          if (weights.custom_scoring_rules && weights.custom_scoring_rules.length > 0) {
            const newScore = await computeLeadScore(item.existing, weights);
            await db.updateLeadScore(item.id, newScore);
          }
        } catch (upErr) {
          console.error('[JobQueue] Error updating existing lead:', item.id, upErr);
        }
      }));
    }

    // Bulk junction link existing leads to campaign
    if (targetCampaign && existingLeadIdsToLink.length > 0) {
      try {
        await db.addLeadsToCampaign(tenant_id, existingLeadIdsToLink, targetCampaign.id);
      } catch (linkErr) {
        console.error('[JobQueue] Error bulk linking existing leads:', linkErr);
      }
    }

    // 3. Bulk insert new leads for this chunk
    if (newLeadsToInsert.length > 0) {
      try {
        const insertedLeads = await db.insertLeads(newLeadsToInsert);
        const insertedLeadIds = (insertedLeads || []).map(l => l.id).filter(Boolean);

        // 4. Bulk junction link to campaign
        if (targetCampaign && insertedLeadIds.length > 0) {
          await db.addLeadsToCampaign(tenant_id, insertedLeadIds, targetCampaign.id);
        }

        for (let idx = 0; idx < newLeadsToInsert.length; idx++) {
          const meta = newLeadsMeta[idx];
          const savedLead = (insertedLeads && insertedLeads[idx]) || newLeadsToInsert[idx];
          accepted++;
          details.push({
            index: meta.index,
            phone: meta.phone,
            status: 'accepted',
            lead_id: savedLead.id,
            score: meta.score
          });

          if (savedLead.raw_data?.crm_id || savedLead.email) {
            crmSyncBatch.push(savedLead);
          }
        }
      } catch (insertErr) {
        console.error('[JobQueue] Bulk insert error for chunk:', insertErr);
      }
    }

    // Throttled CRM sync-back in background (non-blocking)
    if (crmSyncBatch.length > 0) {
      throttledSyncToCRM(tenant_id, crmSyncBatch, process.env.CRM_PROVIDER || null).catch(err => {
        console.error('[JobQueue] Throttled CRM sync error:', err);
      });
    }

    // 5. Update intermediate campaign stats for live progress in UI
    if (campaign_id) {
      await db.updateCampaign(campaign_id, {
        processed_leads: accepted + appended,
        failed_leads: (c + chunk.length) - (accepted + appended)
      });
    }

    // Touch job heartbeat
    await db.updateJobStatus(job.id, 'processing', {
      progress: {
        processed: accepted + appended,
        total: leads.length
      }
    });
  }

  await db.insertAuditLog(tenant_id, 'batch_leads_ingested', {
    dataset_id: dataset_id || 'batch-upload',
    campaign_name: campaign_name || 'Batch Campaigns',
    accepted,
    appended
  });

  await sendSlackNotification(`[Ingestion Alert] Bulk leads uploaded: ${accepted} ingested, ${appended} appended for campaign "${campaign_name || 'Batch Campaigns'}".`);

  if (campaign_id) {
    let finalStatus = 'draft';
    if (campaign) {
      const refreshedCampaign = await db.getCampaign(campaign.id);
      if (refreshedCampaign && refreshedCampaign.status !== 'ingesting') {
        finalStatus = refreshedCampaign.status;
      } else {
        finalStatus = 'draft';
      }
      
      if (campaign.launch_strategy === 'immediate') {
        if (refreshedCampaign && (refreshedCampaign.status === 'paused' || refreshedCampaign.status === 'draft')) {
          console.warn(`[JobQueue] Skipping auto-dial for "${campaign.name}" because its status was changed to '${refreshedCampaign.status}' during ingestion.`);
        } else {
          finalStatus = 'active';
          await db.updateCampaign(campaign_id, {
            status: finalStatus,
            processed_leads: accepted + appended,
            failed_leads: leads.length - (accepted + appended)
          });
          try {
            console.log(`[JobQueue] Auto-starting immediate campaign: ${campaign.name}`);
            await dialAllCampaignLeads(tenant_id, campaign_id, campaign.whatsapp_threshold || 70, campaign.max_concurrency || 3);
          } catch (err) {
            console.error('[JobQueue] Failed to auto-start immediate campaign:', err);
          }
        }
      }
    }

    await db.updateCampaign(campaign_id, {
      status: finalStatus,
      processed_leads: accepted + appended,
      failed_leads: leads.length - (accepted + appended)
    });
  }

  return {
    success: true,
    summary: { accepted, appended, total: leads.length },
    details
  };
}

/**
 * Fetch and process the next pending job.
 */
export async function processNextJob() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const job = await db.fetchNextPendingJob();
    if (!job) {
      isProcessing = false;
      return;
    }

    console.log(`[JobQueue] Starting job ${job.id} of type ${job.job_type}`);
    await db.updateJobStatus(job.id, 'processing');

    let result = null;
    try {
      if (job.job_type === 'batch_ingest') {
        result = await processBatchIngest(job);
      } else {
        throw new Error(`Unknown job type: ${job.job_type}`);
      }
      
      await db.updateJobStatus(job.id, result.success ? 'completed' : 'failed', result);
      console.log(`[JobQueue] Completed job ${job.id}`);
    } catch (err) {
      console.error(`[JobQueue] Error processing job ${job.id}:`, err);
      await db.updateJobStatus(job.id, 'failed', { error: err.message });
      if (job.job_type === 'batch_ingest' && job.payload && job.payload.campaign_id) {
        try {
          await db.updateCampaign(job.payload.campaign_id, { status: 'failed' });
        } catch (e) {
          console.error('[JobQueue] Error updating campaign status on failure:', e);
        }
      }
    }
  } catch (err) {
    console.error('[JobQueue] Error fetching job:', err);
  } finally {
    isProcessing = false;
  }
}

/**
 * Enqueue a new background job.
 */
export async function enqueueJob(tenant_id, type, payload) {
  return await db.insertJob(tenant_id, type, payload);
}

/**
 * Start the background worker polling.
 */
export function startWorker(intervalMs = 5000) {
  if (workerInterval) return;
  console.log(`[JobQueue] Starting background worker (interval: ${intervalMs}ms)`);
  workerInterval = setInterval(processNextJob, intervalMs);
}

export function stopWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[JobQueue] Stopped background worker');
  }
}
