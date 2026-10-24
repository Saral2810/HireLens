import express, { Router } from 'express';
import { requireSuperAdmin } from '../middleware/auth.js';
import { dispatcherLogs } from '../workers/dispatcher.js';

import { connectedDispositions } from "../utils/constants.js";
import crypto from 'crypto';
import db from '../config/db.js';
import { dialAllCampaignLeads } from '../services/campaignDialer.js';

// Feature flag for WhatsApp integration
const WHATSAPP_ENABLED = process.env.WHATSAPP_ENABLED === 'true';
import { validateLead, validateScoringWeights, cleanPhone, validateScript } from '../utils/validation.js';
import { computeLeadScore, computeDynamicScore } from '../services/scoringEngine.js';
import { analyzeTranscript } from '../services/llmService.js';
import voiceProviderFactory from '../services/voiceProvider/index.js';
import { sendSlackNotification } from '../services/slackService.js';
import { syncToCRM } from '../services/crmService.js';
import { enqueueLead, handleCallOutcome, forceRetry, getQueueStats, isCallable, processQueue } from '../services/queueService.js';
import { enqueueJob } from '../services/jobQueue.js';
import { checkEscalation } from '../services/escalationService.js';
import { handleEscalation } from '../services/handoffService.js';
import { tenantConfigService } from '../services/tenantConfigService.js';
import { parseAgentName } from '../lib/tenantIdentity.js';

const DEFAULT_PROVIDER = process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
const APP_URL = () => (process.env.PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');

const staleRetriggerCache = new Map();



const deriveLeadDisplayName = (l) => {
  if (!l) return 'Unknown';
  const parts = [l.first_name, l.last_name].filter(Boolean).join(' ').trim();
  if (parts) return parts;
  if (l.name) return l.name;
  const raw = l.raw_data || {};
  const rawName = raw.name || raw.customer_name || raw.borrower_name ||
                  raw.borrower_full_name || raw.client_name || raw.party_name ||
                  raw.customer_full_name || raw.applicant_name || raw.contact_name ||
                  raw.full_name || raw.lead_name;
  if (rawName) return rawName;
  return l.phone ? 'Lead ending ' + l.phone.slice(-4) : 'Lead';
};

const router = Router();

/**
 * GET /leads/config
 * Retrieves scoring weights configuration for a tenant.
 */
router.get('/config', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    const weights = await db.getWeights(tenant_id);
    res.json({ success: true, tenant_id, weights });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/config
 * Updates scoring weights configuration for a tenant.
 */
router.post('/config', async (req, res, next) => {
  try {
    const { weights, changed_by  } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }

    const valResult = validateScoringWeights(weights);
    if (!valResult.isValid) {
      return res.status(400).json({ error: 'Validation Error', message: 'Invalid scoring weights configuration', errors: valResult.errors });
    }

    await db.upsertWeights(tenant_id, weights, changed_by || 'system');
    
    // Slack notice
    await sendSlackNotification(`[Configuration Alert] Scoring weights modified for tenant "${tenant_id}" by user "${changed_by || 'system'}".`);
    
    res.json({ success: true, tenant_id, weights });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/unassigned
 * Retrieves all leads that are not assigned to a campaign.
 */
router.get('/unassigned', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }
    const leads = await db.getUnassignedLeads(tenant_id);
    res.json({ success: true, count: leads.length, leads });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads
 * Retrieves all leads for a tenant.
 */
router.get('/', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    let leads;
    if (req.query.campaign_id) {
      leads = await db.getLeadsForCampaign(tenant_id, req.query.campaign_id);
    } else {
      leads = await db.getLeads(tenant_id);
    }
    const enrichedLeads = leads.map(l => ({
      ...l,
      dial_attempts: l.raw_data?.attempts || 0
    }));
    res.json({ success: true, leads: enrichedLeads });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/export
  * Exports leads for a tenant with optional filtering and format options.
  */
router.get('/export', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    let leads = await db.getLeads(tenant_id);
    
    if (req.query.lead_ids) {
      const idList = req.query.lead_ids.split(',').map(id => id.trim()).filter(Boolean);
      leads = leads.filter(l => idList.includes(l.id));
    }
    if (req.query.campaign_id && req.query.campaign_id !== 'all') {
      leads = leads.filter(l => (l.campaign_name && l.campaign_name.includes(req.query.campaign_id)) || l.raw_data?.campaign_id === req.query.campaign_id);
    }
    if (req.query.status && req.query.status !== 'all') {
      leads = leads.filter(l => l.status === req.query.status);
    }

    if (!leads || leads.length === 0) {
      return res.status(404).json({ error: 'Not Found', message: 'No leads found matching criteria to export.' });
    }

    if (req.query.format === 'json') {
      return res.json({ success: true, count: leads.length, leads });
    }

    const headers = ['id', 'name', 'phone', 'email', 'status', 'score', 'campaign_name', 'created_at'];
    const csvRows = [headers.join(',')];
    
    for (const lead of leads) {
      const row = headers.map(header => {
        let val = lead[header] !== undefined && lead[header] !== null ? lead[header] : '';
        // Escape quotes and wrap in quotes if there's a comma
        if (typeof val === 'string') {
          val = val.replace(/"/g, '""');
          if (val.includes(',') || val.includes('\n') || val.includes('"')) {
            val = `"${val}"`;
          }
        } else if (typeof val === 'object') {
          val = JSON.stringify(val).replace(/"/g, '""');
          val = `"${val}"`;
        }
        return val;
      });
      csvRows.push(row.join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="leads_export_${Date.now()}.csv"`);
    res.send(csvRows.join('\n'));
  } catch (error) {
    next(error);
  }
});


/**
 * POST /leads/batch-action
 * Performs bulk operations on a set of selected leads (rescore, enqueue, dnc, assign_campaign).
 */
router.post('/batch-action', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { action, lead_ids, params } = req.body;

    if (!action) {
      return res.status(400).json({ error: 'Validation Error', message: 'action is required' });
    }
    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return res.status(400).json({ error: 'Validation Error', message: 'lead_ids must be a non-empty array' });
    }

    const weights = await db.getWeights(tenant_id);
    const results = [];

    for (const id of lead_ids) {
      const lead = await db.findLeadById(id);
      if (!lead || lead.tenant_id !== tenant_id) continue;

      if (action === 'rescore') {
        const newScore = await computeLeadScore(lead, weights);
        await db.updateLeadScore(lead.id, newScore);
        lead.score = newScore;
        results.push({ id: lead.id, action: 'rescored', score: newScore });
      } else if (action === 'enqueue') {
        const score = lead.score || 0;
        await db.updateLeadStatus(lead.id, 'queued');
        await enqueueLead(lead.id, score);
        results.push({ id: lead.id, action: 'queued', score });
      } else if (action === 'dnc') {
        await db.addDncNumber(tenant_id, lead.phone);
        await db.updateLeadStatus(lead.id, 'dnc');
        results.push({ id: lead.id, action: 'dnc_blocked', phone: lead.phone });
      } else if (action === 'assign_campaign') {
        const newCampaign = params?.campaign_name || 'Assigned Campaign';
        await db.updateLeadCampaignAndData(lead.id, newCampaign, lead.raw_data || {});
        results.push({ id: lead.id, action: 'campaign_assigned', campaign_name: newCampaign });
      }
    }

    await db.insertAuditLog(tenant_id, `batch_action_${action}`, {
      action,
      count: results.length,
      lead_ids
    });

    res.json({
      success: true,
      action,
      processed_count: results.length,
      results
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/simulate-score
 * Preview score calculation breakdown without inserting or modifying any lead in the database.
 */
router.post('/simulate-score', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { lead, custom_weights } = req.body;

    if (!lead) {
      return res.status(400).json({ error: 'Validation Error', message: 'lead payload is required' });
    }

    const weights = custom_weights || await db.getWeights(tenant_id);
    const onboardingConfig = await db.getOnboardingConfig(tenant_id);
    if (!custom_weights && onboardingConfig.custom_scoring_rules) {
      weights.custom_scoring_rules = onboardingConfig.custom_scoring_rules;
    }

    const finalScore = await computeLeadScore(lead, weights);

    // Compute factor breakdowns for transparent explanation in UI
    const factors = {
      base: 20,
      demographic: 0,
      source: 0,
      recency: 0,
      behavioral: 0,
      custom_rules: 0
    };

    const raw = lead.raw_data || {};
    if (raw.income || raw.monthly_income) {
      const inc = Number(raw.income || raw.monthly_income);
      factors.demographic += inc >= 50000 ? 25 : inc >= 25000 ? 15 : 8;
    } else {
      factors.demographic += 10;
    }

    const src = (lead.source || '').toLowerCase();
    if (src.includes('referral') || src.includes('inbound') || src.includes('organic')) {
      factors.source = 25;
    } else if (src.includes('facebook') || src.includes('google') || src.includes('paid')) {
      factors.source = 18;
    } else {
      factors.source = 12;
    }

    if (raw.pages_visited || raw.video_watched) {
      factors.behavioral = (Number(raw.pages_visited || 0) * 3) + (raw.video_watched ? 12 : 0);
    }

    let tier = 'Cold';
    if (finalScore >= 80) tier = 'Hot';
    else if (finalScore >= 50) tier = 'Warm';

    res.json({
      success: true,
      simulated_score: finalScore,
      tier,
      weights_used: weights,
      factor_breakdown: factors,
      recommendation: finalScore >= 80 
        ? 'High intent prospect — route to instantaneous AI voice dialing.'
        : finalScore >= 50 
        ? 'Moderate interest — standard campaign scheduling window.'
        : 'Low initial score — nurture via automated WhatsApp brochure.'
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/ingest
 * Ingest a single lead, check for duplicate, compute score, and insert.
 */
router.post('/ingest', async (req, res, next) => {
  try {
    const leadData = req.body;

    // Validate request body
    const valResult = validateLead(leadData);
    if (!valResult.isValid) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid lead payload',
        errors: valResult.errors
      });
    }

    let processedLeadData = leadData;
    const tConfig = await tenantConfigService.getTenantConfig(leadData.tenant_id);

    // Hook: run a tenant-specific lead pre-processor here if needed (tConfig.ingestion.customProcessor).
    void tConfig;

    const { tenant_id, phone } = processedLeadData;
    const cleaned = cleanPhone(phone);

    // Check for duplicate in database
    const existingLead = await db.findLeadByPhone(tenant_id, cleaned);
    if (existingLead) {
      const newCampaign = leadData.campaign_name || 'Manual Campaigns';
      
      existingLead.raw_data = existingLead.raw_data || {};
      if (!existingLead.raw_data.platform_lead_id) {
        existingLead.raw_data.platform_lead_id = leadData.raw_data?.platform_lead_id || 'lead_' + Math.random().toString(36).substr(2, 9);
      }
      
      // Update with the most recent campaign_id
      const mostRecentCampaignId = leadData.raw_data?.campaign_id || 'cmp_' + Math.random().toString(36).substr(2, 9);
      existingLead.raw_data.campaign_id = mostRecentCampaignId;

      // Resolve campaign
      const campaigns = await db.getCampaigns(tenant_id);
      let campaign = campaigns.find(c => c.name.toLowerCase() === newCampaign.toLowerCase());
      if (!campaign) {
        campaign = await db.insertCampaign({ tenant_id, name: newCampaign, status: 'ingesting', total_leads: 0 });
      }

      await db.updateLeadCampaignAndData(existingLead.id, newCampaign, existingLead.raw_data);
      existingLead.campaign_name = newCampaign;
      
      await db.addLeadToCampaign(tenant_id, existingLead.id, campaign.id);

      // Sync duplicate lead back to CRM
      if (existingLead.raw_data?.crm_id || existingLead.email) {
        syncToCRM(tenant_id, existingLead, process.env.CRM_PROVIDER || null).catch(err => {
          console.error('[Ingestion Sync-Back] Failed to sync duplicate lead to CRM:', existingLead.id, err);
        });
      }
      
      return res.status(200).json({
        success: true,
        message: 'Lead already exists. Appended to new campaign.',
        lead: existingLead
      });
    }

    // Retrieve tenant configuration for scoring
    const weights = await db.getWeights(tenant_id);
    const onboardingConfig = await db.getOnboardingConfig(tenant_id);
    if (onboardingConfig.custom_scoring_rules) {
      weights.custom_scoring_rules = onboardingConfig.custom_scoring_rules;
    }

    // Clean data and build structured lead
    const processedLead = {
      ...processedLeadData,
      phone: cleaned,
      dataset_id: processedLeadData.dataset_id || 'manual-entry',
      campaign_name: processedLeadData.campaign_name || 'Manual Campaigns',
      raw_data: processedLeadData.raw_data || {}
    };

    if (!processedLead.raw_data.platform_lead_id) {
      processedLead.raw_data.platform_lead_id = 'lead_' + Math.random().toString(36).substr(2, 9);
    }
    if (!processedLead.raw_data.campaign_id) {
      processedLead.raw_data.campaign_id = 'cmp_' + Math.random().toString(36).substr(2, 9);
    }

    // Calculate score
    const score = await computeLeadScore(processedLead, weights);
    processedLead.score = score;

    // Save lead
    const savedLead = await db.insertLead(processedLead);

    // Resolve campaign
    const campaigns = await db.getCampaigns(tenant_id);
    let campaign = campaigns.find(c => c.name.toLowerCase() === (processedLead.campaign_name || 'Manual Campaigns').toLowerCase());
    if (!campaign) {
      campaign = await db.insertCampaign({ tenant_id, name: processedLead.campaign_name || 'Manual Campaigns', status: 'ingesting', total_leads: 0 });
    }
    await db.addLeadToCampaign(tenant_id, savedLead.id, campaign.id);

    // Enqueue in dialer priority queue
    await enqueueLead(savedLead.id, score);

    // Asynchronously sync back to CRM
    if (savedLead.raw_data?.crm_id || savedLead.email) {
      syncToCRM(tenant_id, savedLead, process.env.CRM_PROVIDER || null).catch(err => {
        console.error('[Ingestion Sync-Back] Failed to sync new lead to CRM:', savedLead.id, err);
      });
    }

    // Insert System Audit Log
    await db.insertAuditLog(tenant_id, 'lead_ingested', {
      lead_id: savedLead.id,
      phone: cleaned,
      score,
      dataset_id: processedLead.dataset_id,
      campaign_name: processedLead.campaign_name
    });

    // Slack Notification for Hot Lead Ingestion
    const hotThreshold = onboardingConfig.thresholds?.hot || 80;
    if (score >= hotThreshold) {
      await sendSlackNotification(`[Ingestion Alert] HOT Lead Ingested: ${savedLead.name || 'Unknown'} (${cleaned}) scored ${score}/100.`);
    }

    res.status(201).json({
      success: true,
      lead: savedLead
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/batch
 * Processes batch of up to 50000 leads.
 */
router.post('/batch', async (req, res, next) => {
  try {
    const { leads, dataset_id, campaign_name, max_concurrency, custom_scoring_rules, launch_strategy } = req.body;
    const tenant_id = req.tenant_id || req.body?.tenant_id || req.headers['x-tenant-id'];

    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }
    if (!leads || !Array.isArray(leads)) {
      return res.status(400).json({ error: 'Validation Error', message: 'leads must be an array of lead objects' });
    }

    if (req.body.voice_agent_id) {
      if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(req.body.voice_agent_id)) {
        return res.status(400).json({ error: 'Invalid voice_agent_id' });
      }
    }

    // Reuse existing campaign if already created, or create a new campaign record
    const existingCampaigns = await db.getCampaigns(tenant_id);
    let campaign = existingCampaigns.find(c => c.name.toLowerCase() === (campaign_name || '').toLowerCase());
    if (campaign) {
      await db.updateCampaign(campaign.id, {
        total_leads: leads.length,
        status: 'ingesting',
        max_concurrency: max_concurrency !== undefined ? parseInt(max_concurrency) : (campaign.max_concurrency || 3),
        voice_agent_id: req.body.voice_agent_id || campaign.voice_agent_id,
        voice_provider: req.body.voice_provider || campaign.voice_provider,
        launch_strategy: launch_strategy || campaign.launch_strategy
      });
      campaign = await db.getCampaign(campaign.id);
    } else {
      campaign = await db.insertCampaign({
        tenant_id,
        name: campaign_name || 'Batch Campaigns',
        total_leads: leads.length,
        status: 'ingesting',
        max_concurrency: max_concurrency !== undefined ? parseInt(max_concurrency) : 3,
        voice_agent_id: req.body.voice_agent_id || null,
        voice_provider: req.body.voice_provider || null,
        launch_strategy: launch_strategy || null,
        configuration: { custom_scoring_rules: custom_scoring_rules || [] }
      });
    }

    // Enqueue the background job
    const job = await enqueueJob(tenant_id, 'batch_ingest', { 
      tenant_id, leads, dataset_id, campaign_name, campaign_id: campaign.id, custom_scoring_rules
    });
    
    // Link job ID
    await db.updateCampaign(campaign.id, { job_id: job.id });

    // Auto-purge in-progress campaign draft for this tenant on successful launch
    await db.deleteCampaignDraft(tenant_id).catch(() => {});

    res.status(202).json({
      success: true,
      message: 'Batch ingestion started in background.',
      job_id: job.id
    });
  } catch (error) {
    next(error);
  }
});

const RESERVED_LEAD_ROUTES = new Set([
  'config', 'unassigned', 'export', 'telephony', 'onboard', 'audit-trail',
  'events', 'active-sessions', 'crm-lists', 'crm-contacts', 'campaigns',
  'draft', 'queue-status', 'dnc', 'scripts', 'handoff', 'calls',
  'analytics', 'scoring-config', 'campaign', 'debug', 'webhook', 'webhooks', 'recordings'
]);

/**
 * GET /leads/:id
 * Fetches single lead by ID.
 */
router.get('/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (RESERVED_LEAD_ROUTES.has(id)) {
      return next();
    }
    const lead = await db.findLeadById(id);
    if (!lead) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }
    if (lead.tenant_id !== req.tenant_id && !req.user?.isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }
    res.json({ success: true, lead });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/:id/rescore
 * Recomputes score of a lead based on current tenant config.
 */
router.post('/:id/rescore', async (req, res, next) => {
  try {
    const { id } = req.params;
    const lead = await db.findLeadById(id);
    if (!lead || lead.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }

    const weights = await db.getWeights(lead.tenant_id);
    const oldScore = lead.score;
    const newScore = await computeLeadScore(lead, weights);

    let updatedLead = lead;
    if (oldScore !== newScore) {
      updatedLead = await db.updateLeadScore(id, newScore);
    }

    res.json({
      success: true,
      lead_id: id,
      old_score: oldScore,
      new_score: newScore,
      lead: updatedLead
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/:id/resolve
 * Marks a hot escalation as resolved by transitioning status to called.
 */
router.post('/:id/resolve', async (req, res, next) => {
  try {
    const { id } = req.params;
    const lead = await db.findLeadById(id);
    if (!lead || lead.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }
    const updated = await db.updateLeadStatus(id, 'called');
    await db.insertAuditLog(lead.tenant_id, 'escalation_resolved', { lead_id: id });
    res.json({ success: true, lead: updated, message: 'Escalation resolved successfully.' });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/onboard
 * Saves client discovery questionnaire configurations.
 */
router.post('/onboard', async (req, res, next) => {
  try {
    const { onboarding_config, crm_provider_saved  } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }
    if (!onboarding_config) {
      return res.status(400).json({ error: 'Validation Error', message: 'onboarding_config is required' });
    }

    
    if (onboarding_config.thresholds) {
      const { hot, warm } = onboarding_config.thresholds;
      if (hot !== undefined && warm !== undefined && hot <= warm) {
        return res.status(400).json({ error: 'Validation Error', message: 'hot threshold must be strictly greater than warm threshold' });
      }
      if (hot > 100 || warm < 0) {
        return res.status(400).json({ error: 'Validation Error', message: 'thresholds must be between 0 and 100' });
      }
    }

    await db.upsertOnboardingConfig(tenant_id, onboarding_config);

    // Audit log
    await db.insertAuditLog(tenant_id, 'onboarding_config_updated', onboarding_config);

    // Log dedicated connection event if a CRM was explicitly configured
    if (crm_provider_saved) {
      await db.insertAuditLog(tenant_id, 'crm_connected', {
        provider: crm_provider_saved,
        lead_name: `${crm_provider_saved} Integration`,
        phone: 'System Gateway',
        details: {
          provider: crm_provider_saved,
          lead_name: `${crm_provider_saved} Integration`,
          phone: 'System Gateway'
        }
      });
    }

    // Slack alerts
    await sendSlackNotification(`[Onboarding Alert] Client setup completed for tenant "${tenant_id}". Industry segment: ${onboarding_config.industry || 'General'}.`);

    res.json({ success: true, tenant_id, onboarding_config });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/onboard
 * Retrieves onboarding configurations for a tenant.
 */
router.get('/onboard', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    const onboarding_config = await db.getOnboardingConfig(tenant_id);
    res.json({ success: true, tenant_id, onboarding_config });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/audit-trail
 * Retrieves centralized audit log events.
 */
router.get('/audit-trail', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    const logs = await db.getAuditTrail(tenant_id);
    res.json({ success: true, logs });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/events
 * Retrieves call session event logs.
 */
router.get('/events', async (req, res, next) => {
  try {
    const { event_type  } = req.query;
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    const events = await db.getCallEvents(tenant_id, event_type || null);
    res.json({ success: true, events });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/active-sessions
 * Retrieves all active call sessions for the live monitor.
 */
router.get('/active-sessions', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id || req.query.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    
    // 1. Fetch recent call sessions for the tenant (up to 100 for fast response)
    let sessions;
    if (db.supabase) {
      const { data, error } = await db.supabase
        .from('call_sessions')
        .select('*')
        .eq('tenant_id', tenant_id)
        .order('created_at', { ascending: false })
        .limit(100);
      if (error) throw error;
      sessions = data || [];
    } else {
      sessions = await db.getCallSessions(tenant_id);
    }
    
    // 2. Filter for active sessions (calling + in-progress dispositions), auto-reconciling stale calls > 10m
    const STALE_CALL_CUTOFF_SECS = 600; // 10 minutes max call duration
    const now = Date.now();
    const activeSessions = [];
    
    for (const s of sessions) {
      if (s.disposition === 'calling' || s.disposition === 'in-progress' || s.disposition === 'in_progress') {
        const start = s.started_at ? new Date(s.started_at).getTime() : (s.created_at ? new Date(s.created_at).getTime() : now);
        const elapsedSecs = Math.floor((now - start) / 1000);
        
        if (elapsedSecs > STALE_CALL_CUTOFF_SECS) {
          const lastTriggered = staleRetriggerCache.get(s.provider_session_id) || 0;
          const retriggerInterval = parseInt(process.env.STALE_RETRIGGER_MIN_INTERVAL_MS || '300000', 10);
          if (now - lastTriggered < retriggerInterval) {
            continue; // Skip re-triggering this session for now
          }
          staleRetriggerCache.set(s.provider_session_id, now);

          // Check provider first so real completed calls retain transcripts & details
          (async () => {
            try {
              const isSimulated = !s.provider_session_id || s.provider_session_id.startsWith('mock-') || s.provider_session_id.startsWith('sim-');
              if (!isSimulated) {
                let providerType = DEFAULT_PROVIDER;
                if (s.campaign_id && db.supabase) {
                  try {
                    const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('id', s.campaign_id).maybeSingle();
                    if (camp?.voice_provider) providerType = camp.voice_provider;
                  } catch (_) {}
                }
                const provider = await voiceProviderFactory.getProvider(tenant_id, providerType);
                const artifacts = await provider.fetchArtifacts(s.provider_session_id, s);
                if (artifacts && (artifacts.transcript || artifacts.summary || (artifacts.disposition && artifacts.disposition !== 'calling'))) {
                  await handleCallOutcome(
                    s.provider_session_id,
                    artifacts.disposition || 'completed',
                    artifacts.duration_seconds || 0,
                    artifacts.summary || '',
                    artifacts.transcript || null,
                    artifacts.sentiment || '',
                    artifacts.recording_url || null,
                    artifacts.structured_outputs || null
                  );
                  return;
                }
              }
              await handleCallOutcome(s.provider_session_id, 'no_answer', 0, 'Call session timed out without response.');
            } catch (err) {
              await handleCallOutcome(s.provider_session_id, 'no_answer', 0, 'Call session timed out without response.').catch(() => {});
            }
          })();
        } else {
          activeSessions.push(s);
        }
      }
    }
    
    // 3. Prepare recent completed calls (last 10 sessions)
    const completedSessions = sessions
      .filter(s => !['calling', 'in-progress', 'in_progress'].includes(s.disposition))
      .sort((a, b) => new Date(b.ended_at || b.created_at) - new Date(a.ended_at || a.created_at))
      .slice(0, 10);

    // 4. Fetch only relevant leads (active + completed) instead of the whole database
    const activeLeadIds = activeSessions.map(s => s.lead_id).filter(Boolean);
    const completedLeadIds = completedSessions.map(s => s.lead_id).filter(Boolean);
    const neededLeadIds = [...new Set([...activeLeadIds, ...completedLeadIds])];

    const leadMap = new Map();
    if (db.supabase && neededLeadIds.length > 0) {
      const { data: leadRows } = await db.supabase
        .from('leads')
        .select('id, name, phone, score, status, raw_data')
        .in('id', neededLeadIds);
      (leadRows || []).forEach(l => leadMap.set(l.id, l));
    } else if (neededLeadIds.length > 0) {
      const allLeads = await db.getLeads(tenant_id);
      allLeads.forEach(l => leadMap.set(l.id, l));
    }
    
    const activeCalls = activeSessions.map(session => {
      const lead = leadMap.get(session.lead_id) || {};
      
      // Calculate active duration
      let durationSeconds = 0;
      if (session.created_at) {
        const start = new Date(session.created_at).getTime();
        const now = Date.now();
        durationSeconds = Math.floor((now - start) / 1000);
      }
      
      return {
        session_id: session.id,
        provider_session_id: session.provider_session_id,
        lead_id: session.lead_id,
        lead_name: deriveLeadDisplayName(lead),
        phone: lead.phone || 'Unknown',
        score: lead.score || 0,
        status: lead.status || 'queued',
        duration_seconds: durationSeconds
      };
    });

    // 5. Return recent completed/attempted calls (last 10 sessions)

    const recentCalls = completedSessions.map(session => {
      const lead = leadMap.get(session.lead_id) || {};
      const raw = lead.raw_data || {};
      return {
        session_id: session.id,
        provider_session_id: session.provider_session_id,
        lead_id: session.lead_id,
        lead_name: deriveLeadDisplayName(lead),
        phone: lead.phone || 'Unknown',
        score: lead.score || 0,
        disposition: session.disposition || 'completed',
        duration_seconds: session.duration || session.call_duration_seconds || raw.call_duration_seconds || 0,
        recording_url: session.recording_url || raw.recording_url || null,
        has_transcript: !!(session.transcript_json || raw.transcript_json),
        summary: session.summary || raw.summary || null,
        ended_at: session.ended_at || session.created_at
      };
    });
    
    res.json({ success: true, active_calls: activeCalls, recent_calls: recentCalls });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/trigger-call
 * Triggers an outbound call for one lead via the tenant's voice provider.
 */
router.post('/trigger-call', async (req, res, next) => {
  try {
    const { lead_id  } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id || !lead_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id and lead_id are required' });
    }

    const lead = await db.findLeadById(lead_id);
    if (!lead || lead.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }

    const onboarding = await db.getOnboardingConfig(tenant_id);

    // Platform-maintained DNC check (default to true unless explicit client override)
    const usePlatformDnc = onboarding.dnc_validation_ownership !== 'client';
    const isDnc = await db.isDncNumber(tenant_id, lead.phone);
    if (usePlatformDnc && isDnc) {
      await db.updateLeadStatus(lead_id, 'dnc');
      
      await db.insertAuditLog(tenant_id, 'dnc_block', {
        lead_id: lead.id,
        phone: lead.phone
      });
      await sendSlackNotification(`[DNC Block] outbound dial blocked to DNC number: ${lead.phone}`);
      return res.status(400).json({ error: 'DNC Block', message: 'The number is registered on the national DNC database.' });
    }

    // Dynamic URL mapping
    const protocol = req.protocol;
    const host = req.get('host');
    // Use the lead's campaign settings (provider + agent) when available
    const campaigns = await db.getCampaigns(tenant_id);
    const leadCampaign = campaigns.find(c => c.name === lead.campaign_name);
    const campId = leadCampaign?.id;
    const providerType = req.body.voice_provider || leadCampaign?.voice_provider || onboarding?.aiAgent?.voiceProvider || DEFAULT_PROVIDER;
    const webhookUrl = `${process.env.PUBLIC_APP_URL ? APP_URL() : `${protocol}://${host}`}/leads/webhook/${providerType}?tenant_id=${encodeURIComponent(tenant_id)}`;

    // Initialize session via adapter
    const provider = await voiceProviderFactory.getProvider(lead.tenant_id, providerType);
    const result = await provider.initSession(lead, { ...onboarding, voice_agent_id: req.body.voice_agent_id || leadCampaign?.voice_agent_id || null, campaign: leadCampaign }, webhookUrl);

    if (result.status === 'queued') {
      await db.updateLeadStatus(lead_id, 'provider_queued');
    } else {
      await db.updateLeadStatus(lead_id, 'calling');
    }

    // Save initial call session
    const session = await db.insertCallSession({
      tenant_id,
      lead_id,
      campaign_id: campId,
      provider_session_id: result.provider_session_id,
      disposition: result.status === 'queued' ? 'provider_queued' : 'calling'
    });

    await db.insertAuditLog(tenant_id, 'call_initiated', {
      lead_id,
      provider_session_id: result.provider_session_id,
      phone: lead.phone
    });

    res.json({ success: true, message: 'Call session initiated', provider_session_id: result.provider_session_id, session_id: session.id });
  } catch (error) {
    next(error);
  }
});

/**
 * Shared logic for voice provider stream webhook events.
 * Used by POST /leads/webhook/:provider.
 */
async function processVoiceStreamEvent(tenant_id, session, activeEventType, rawEvent, rawPayload, provider, providerSessionId, res, db, checkEscalation, handleEscalation, handleCallOutcome) {
  if (activeEventType !== 'escalation_triggered' && activeEventType !== 'call_ended' && activeEventType !== 'call_started' && activeEventType !== 'post_call_transcription') {
    try {
      const onboarding = await db.getOnboardingConfig(tenant_id);
      const scriptId = onboarding.active_script_id || 'default-script';
      const scriptConfig = await db.getLatestScript(tenant_id, scriptId);
      if (scriptConfig) {
        const transcript = rawPayload?.transcript || '';
        const duration = rawPayload?.call_duration_seconds || rawPayload?.duration || 0;
        const sentiment = rawPayload?.sentiment || 'neutral';
        const escResult = checkEscalation(transcript, duration, sentiment, scriptConfig);
        if (escResult.shouldEscalate) {
          activeEventType = 'escalation_triggered';
          rawPayload = {
            ...(rawPayload || {}),
            reason: escResult.reason,
            detail: escResult.detail
          };
        }
      }
    } catch (err) {
      console.error('Error running checkEscalation inside webhook:', err.message);
    }
  }

  if (activeEventType === 'escalation_triggered') {
    await handleEscalation(providerSessionId, { ...rawEvent, payload: rawPayload });
  } else if (activeEventType === 'call_started') {
    if (provider.startHeartbeat) provider.startHeartbeat(providerSessionId);
    await db.updateCallSession(session.id, { disposition: 'in-progress' });
    if (session.lead_id) await db.updateLeadStatus(session.lead_id, 'in-progress');
  } else if (activeEventType === 'call_ended' || activeEventType === 'post_call_transcription') {
    // IMMEDIATELY free the dispatcher slot regardless of transcript/scoring success
    if (providerSessionId) {
      try { await db.supabase.rpc('fn_release_slot', { p_call_id: providerSessionId }); } catch (_) { /* non-fatal */ }
    }

    let parsedDisposition = String(rawPayload?.disposition || rawPayload?.call_status || rawPayload?.status || rawEvent?.disposition || 'completed').toLowerCase();
    let duration = rawPayload?.call_duration_seconds || rawPayload?.duration || rawPayload?.duration_seconds || rawEvent?.call_duration_seconds || rawEvent?.duration || 0;
    let transcript = rawPayload?.transcript_json || rawPayload?.transcript || rawPayload?.messages || rawPayload?.conversation || rawEvent?.transcript_json || rawEvent?.transcript || null;
    let summary = rawPayload?.summary || rawEvent?.summary || '';
    let sentiment = rawPayload?.sentiment || rawPayload?.customer_sentiment || rawEvent?.sentiment || '';
    let recordingUrl = rawPayload?.recording_url || rawPayload?.audio_url || rawEvent?.recording_url || null;

    const extraContext = { ...(session || {}), ...(rawPayload || {}) };

    if (provider.fetchArtifacts && (!transcript || !recordingUrl)) {
      try {
        const artifacts = await provider.fetchArtifacts(providerSessionId, extraContext);
        transcript = transcript || artifacts.transcript;
        recordingUrl = recordingUrl || artifacts.recording_url;
        duration = duration || artifacts.duration_seconds;
        parsedDisposition = artifacts.disposition && parsedDisposition === 'completed' ? artifacts.disposition : parsedDisposition;
        summary = summary || artifacts.summary;
      } catch (err) {
        console.error('[Webhook] Error fetching provider artifacts:', err);
      }
    }

    const needsTranscriptRetry = (!transcript || !recordingUrl) && provider.fetchArtifacts && providerSessionId && !providerSessionId.startsWith('mock-');

    if (needsTranscriptRetry) {
      console.log(`[Webhook] Holding handleCallOutcome for ${providerSessionId} to wait for late artifacts...`);
      setTimeout(async () => {
        try {
          const lateArtifacts = await provider.fetchArtifacts(providerSessionId, extraContext);
          console.log(`[Webhook] Late artifacts fetch for ${providerSessionId}. Found transcript: ${!!lateArtifacts.transcript}`);
          await handleCallOutcome(
            providerSessionId,
            lateArtifacts.disposition || parsedDisposition,
            lateArtifacts.duration_seconds || duration,
            lateArtifacts.summary || summary,
            lateArtifacts.transcript || transcript,
            lateArtifacts.sentiment || sentiment,
            lateArtifacts.recording_url || recordingUrl
          );
        } catch (retryErr) {
          console.warn('[Webhook] Background artifact retry error:', retryErr.message);
          // Fallback if provider fails
          await handleCallOutcome(providerSessionId, parsedDisposition, duration, summary, transcript, sentiment, recordingUrl).catch(() => {});
        }
      }, 5000);
    } else {
      handleCallOutcome(
        providerSessionId,
        parsedDisposition,
        duration,
        summary,
        transcript,
        sentiment,
        recordingUrl
      ).catch(err => console.error('[Webhook] Error handling call outcome in background:', err));
    }
  } else if (activeEventType === 'tool_call' || activeEventType === 'function_call') {
    const functionName = rawPayload?.name || rawPayload?.function_name;
    const functionArgs = rawPayload?.arguments || {};
    let toolResult = {};
    
    // Hook: handle mid-call tool / function calls from your voice agent here.
    // Example:
    //   if (functionName === 'book_slot') { toolResult = { booked: true }; }
    console.log(`[Webhook] Tool call received: ${functionName}`, functionArgs);
    toolResult = { status: 'not_implemented', function: functionName };

    return res.json({ success: true, tool_result: toolResult });
  }

  return res.json({ success: true });
}



/**
 * GET /leads/:id/transcript
 * Returns the stored transcript and structured analysis for a lead's latest call session.
 * Falls back to the voice provider's fetchArtifacts() if the transcript is not yet stored.
 */
router.get('/:id/transcript', async (req, res, next) => {
  try {
    const { id } = req.params;
    const lead = await db.findLeadById(id);
    if (!lead || lead.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }

    const leadSessions = await db.getCallSessionsByLeadId(lead.id, lead.tenant_id);
    const latestSession = leadSessions[0];

    if (!latestSession) {
      return res.json({ success: true, transcript: null, analysis: null, recording_url: null, message: 'No call session found for this lead.' });
    }

    let transcript   = latestSession.transcript_json || null;
    let analysis     = latestSession.analysis || null;
    let recordingUrl = latestSession.recording_url || null;
    let duration     = latestSession.call_duration_seconds || latestSession.duration || 0;
    let summary      = latestSession.summary || null;
    let disposition  = latestSession.disposition || 'completed';

    // If transcript is missing or still in calling state and session has a real provider ID, fetch from the provider
    const isSimulated = !latestSession.provider_session_id ||
      latestSession.provider_session_id.startsWith('mock-') ||
      latestSession.provider_session_id.startsWith('sim-') ||
      latestSession.provider_session_id.startsWith('pending-');

    if ((!transcript || req.query.refresh === 'true' || ['calling', 'in-progress'].includes(latestSession.disposition)) && !isSimulated) {
      try {
        let providerType = DEFAULT_PROVIDER;
        if (latestSession.campaign_id && db.supabase) {
          try {
            const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('id', latestSession.campaign_id).maybeSingle();
            if (camp?.voice_provider) providerType = camp.voice_provider;
          } catch (_) {}
        } else if (lead.campaign_name && db.supabase) {
          try {
            const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('name', lead.campaign_name).eq('tenant_id', lead.tenant_id).maybeSingle();
            if (camp?.voice_provider) providerType = camp.voice_provider;
          } catch (_) {}
        }
        const provider = await voiceProviderFactory.getProvider(lead.tenant_id, providerType);
        const artifacts = await provider.fetchArtifacts(latestSession.provider_session_id, latestSession);
        if (artifacts && (artifacts.transcript || artifacts.summary || artifacts.disposition)) {
          recordingUrl = artifacts.recording_url || recordingUrl;
          duration     = artifacts.duration_seconds || duration;
          summary      = artifacts.summary || summary;
          analysis     = artifacts.analysis || analysis;
          if (artifacts.disposition && artifacts.disposition !== 'calling') {
            disposition = artifacts.disposition;
          }
          
          const updates = {
            transcript_json: transcript,
            recording_url: recordingUrl,
            duration: duration,
            disposition: disposition,
            summary: summary,
            sentiment: artifacts.sentiment || latestSession.sentiment || null,
            analysis: analysis
          };
          if (disposition !== 'calling' && !latestSession.ended_at) {
            updates.ended_at = new Date().toISOString();
          }

          await db.updateCallSession(latestSession.id, updates).catch(e => console.warn('[GET transcript] Persist to call_sessions failed:', e.message));

          if (lead.raw_data) {
            const raw = { ...lead.raw_data };
            if (transcript) raw.transcript_json = transcript;
            if (recordingUrl) raw.recording_url = recordingUrl;
            if (duration) raw.call_duration_seconds = duration;
            if (summary) raw.summary = summary;
            if (artifacts.sentiment) raw.sentiment = artifacts.sentiment;
            if (analysis) raw.analysis = analysis;
            await db.updateLead(lead.id, { raw_data: raw }).catch(() => {});
          }
        }
      } catch (fetchErr) {
        console.warn('[GET transcript] provider artifact fetch failed (non-fatal):', fetchErr.message);
      }
    }

    return res.json({
      success:       true,
      lead_id:       lead.id,
      lead_name:     lead.name,
      session_id:    latestSession.id,
      provider_call_id:  latestSession.provider_session_id,
      disposition:   disposition,
      duration_seconds: duration,
      recording_url: recordingUrl,
      transcript:    transcript,
      summary:       summary,
      analysis:      analysis,
      sentiment:     latestSession.sentiment || null,
      score_before:  lead.raw_data?.initial_score || null,
      score_after:   lead.raw_data?.after_call_score || lead.score || null,
      call_completed_at: latestSession.ended_at || latestSession.updated_at || null
    });
  } catch (err) {
    next(err);
  }
});

const streamAudioBuffer = (req, res, buffer, contentType, filename) => {
  const total = buffer.length;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
  res.setHeader('Cache-Control', 'public, max-age=86400');

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
    if (isNaN(start) || start >= total || end >= total || start > end) {
      res.setHeader('Content-Range', `bytes */${total}`);
      return res.status(416).send('Requested range not satisfiable');
    }
    const chunksize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': chunksize,
      'Content-Type': contentType,
    });
    return res.end(buffer.subarray(start, end + 1));
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', total);
  return res.end(buffer);
};

/**
 * GET /leads/recordings/:session_id/audio
 * Streams a call recording. If the provider adapter implements fetchRecording(session)
 * (returning { buffer, contentType }), the audio is proxied with the provider's auth;
 * otherwise the browser is redirected to the stored recording_url.
 */
router.get('/recordings/:session_id/audio', async (req, res, next) => {
  try {
    const { session_id } = req.params;
    let session = null;
    if (db.supabase) {
      const { data } = await db.supabase
        .from('call_sessions')
        .select('*')
        .or(`id.eq.${session_id},provider_session_id.eq.${session_id}`)
        .maybeSingle();
      session = data;
    } else {
      session = (db.mockDb?.callSessions || []).find(s => s.id === session_id || s.provider_session_id === session_id);
    }

    if (!session) {
      return res.status(404).json({ error: 'Call session not found.' });
    }

    const recordingUrl = session.recording_url;

    // Optional provider-side proxy
    try {
      let providerType = process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
      if (session.campaign_id && db.supabase) {
        const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('id', session.campaign_id).maybeSingle();
        if (camp?.voice_provider) providerType = camp.voice_provider;
      }
      const provider = await voiceProviderFactory.getProvider(session.tenant_id, providerType);
      if (typeof provider.fetchRecording === 'function') {
        const rec = await provider.fetchRecording(session);
        if (rec?.buffer) {
          return streamAudioBuffer(req, res, rec.buffer, rec.contentType || 'audio/wav', `call_${session_id}`);
        }
      }
    } catch (proxyErr) {
      console.warn('[Recordings] provider proxy failed, falling back to redirect:', proxyErr.message);
    }

    if (!recordingUrl || recordingUrl.includes('/leads/recordings/')) {
      return res.status(404).json({ error: 'No upstream audio recording available for this call.' });
    }
    return res.redirect(recordingUrl);
  } catch (err) {
    next(err);
  }
});





/**
 * GET /leads/campaigns
 * Retrieves unique campaigns for a tenant and aggregates stats.
 */
router.get('/campaigns', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }

    const leads = await db.getLeads(tenant_id);
    const campaignsMap = {};

    const actualCampaigns = await db.getCampaigns(tenant_id);
    if (actualCampaigns && Array.isArray(actualCampaigns)) {
      actualCampaigns.forEach(camp => {
        campaignsMap[camp.name] = {
          name: camp.name,
          status: camp.status,
          ingested: 0,
          attempted: 0,
          connected: 0,
          objective: camp.objective || '',
          total_leads: camp.total_leads || 0
        };
      });
    }

    leads.forEach(lead => {
      const campNames = lead.campaign_name
        ? lead.campaign_name.split(',').map(c => c.trim()).filter(Boolean)
        : ['Manual Ingests'];

      campNames.forEach(campName => {
        if (!campaignsMap[campName]) {
          campaignsMap[campName] = {
            name: campName,
            status: 'active',
            ingested: 0,
            attempted: 0,
            connected: 0,
            objective: lead.raw_data?.campaign_objective || '',
            total_leads: 0
          };
        }
        const camp = campaignsMap[campName];
        camp.ingested += 1;
        
        // attempted means status is not ingested
        if (lead.status && lead.status !== 'ingested') {
          camp.attempted += 1;
        }
        // connected means status is connected
        if (lead.status === 'connected') {
          camp.connected += 1;
        }
      });
    });

    const campaigns = Object.values(campaignsMap).map(camp => {
      const rate = camp.attempted > 0 ? (camp.connected / camp.attempted) * 100 : 0;
      const ingestedCount = camp.ingested > 0 ? camp.ingested : (camp.total_leads || 0);
      return {
        name: camp.name,
        status: camp.status,
        total_leads: camp.total_leads || ingestedCount || 0,
        ingested: ingestedCount,
        attempted: camp.attempted,
        connected: camp.connected,
        connect_rate: parseFloat(rate.toFixed(1)),
        objective: camp.objective || ''
      };
    });

    res.json({ success: true, campaigns });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /leads/campaigns
 * Deletes all leads associated with a campaign name (or removes the campaign reference).
 */
router.delete('/campaigns', async (req, res, next) => {
  try {
    const { campaign_name, campaign_id, id, soft_delete } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }
    const identifier = campaign_id || id || campaign_name;
    if (!identifier) {
      return res.status(400).json({ error: 'Validation Error', message: 'campaign_name or campaign_id is required' });
    }

    const result = await db.deleteCampaign(tenant_id, identifier, { softDelete: soft_delete === true });

    // Audit log
    await db.insertAuditLog(tenant_id, 'campaign_deleted', { identifier, ...result });

    res.json({
      success: true,
      message: `Campaign "${result.campaignName || identifier}" successfully deleted.`,
      ...result
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/draft and GET /leads/campaigns/draft
 */
const handleLeadsGetDraft = async (req, res, next) => {
  try {
    const tenant_id = req.params.tenant_id || req.tenant_id || req.query.tenant_id;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
    const draft = await db.getCampaignDraft(tenant_id);
    res.json({ success: true, draft: draft || null });
  } catch (error) {
    next(error);
  }
};
router.get('/draft', handleLeadsGetDraft);
router.get('/draft/:tenant_id', handleLeadsGetDraft);
router.get('/campaigns/draft', handleLeadsGetDraft);
router.get('/campaigns/draft/:tenant_id', handleLeadsGetDraft);

/**
 * POST /leads/draft and POST /leads/campaigns/draft
 */
const handleLeadsPostDraft = async (req, res, next) => {
  try {
    const tenant_id = req.params.tenant_id || req.tenant_id || req.body?.tenant_id || req.query.tenant_id;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
    const draftPayload = req.body?.draft || req.body;
    const draft = await db.upsertCampaignDraft(tenant_id, draftPayload);
    res.status(200).json({ success: true, draft });
  } catch (error) {
    next(error);
  }
};
router.post('/draft', handleLeadsPostDraft);
router.post('/draft/:tenant_id', handleLeadsPostDraft);
router.post('/campaigns/draft', handleLeadsPostDraft);
router.post('/campaigns/draft/:tenant_id', handleLeadsPostDraft);

/**
 * DELETE /leads/draft and DELETE /leads/campaigns/draft
 */
const handleLeadsDeleteDraft = async (req, res, next) => {
  try {
    const tenant_id = req.params.tenant_id || req.tenant_id || req.query.tenant_id || req.body?.tenant_id;
    if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
    const result = await db.deleteCampaignDraft(tenant_id);
    res.json({ success: true, message: 'Campaign draft discarded successfully', ...result });
  } catch (error) {
    next(error);
  }
};
router.delete('/draft', handleLeadsDeleteDraft);
router.delete('/draft/:tenant_id', handleLeadsDeleteDraft);
router.delete('/campaigns/draft', handleLeadsDeleteDraft);
router.delete('/campaigns/draft/:tenant_id', handleLeadsDeleteDraft);

/**
 * GET /leads/queue-status
 * Returns current metrics of the queue.
 */
router.get('/queue-status', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    const stats = await getQueueStats(tenant_id);
    res.json({ success: true, stats });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/force-retry
 * Triggers the dialer force retry for failed or called contacts across workspace or campaign.
 */
router.post('/force-retry', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { campaign_name } = req.body || {};
    const isPreview = req.query.preview === 'true';
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }
    const count = await forceRetry(tenant_id, campaign_name || null, isPreview);
    if (isPreview) {
      return res.json({ success: true, count, message: 'Preview successful' });
    }
    res.json({ 
      success: true, 
      count, 
      message: campaign_name 
        ? `Re-queued ${count} failed contacts for campaign "${campaign_name}".`
        : `Force retry triggered successfully. Re-queued ${count} leads.` 
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/campaign/:campaign_name/retry-failed
 * Retry all failed / called leads specifically within a campaign.
 */
router.post('/campaign/:campaign_name/retry-failed', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { campaign_name } = req.params;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }
    const count = await forceRetry(tenant_id, campaign_name);
    res.json({ 
      success: true, 
      count, 
      message: `Re-queued ${count} failed contacts for campaign "${campaign_name}".` 
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/dnc
 * Enrolls a lead phone number to the Do Not Call registry.
 */
router.post('/dnc', async (req, res, next) => {
  try {
    const { phone  } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id || !phone) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id and phone are required' });
    }
    const cleaned = cleanPhone(phone);
    await db.addDncNumber(tenant_id, cleaned);
    
    // Find lead and mark as dnc
    const lead = await db.findLeadByPhone(tenant_id, cleaned);
    if (lead) {
      await db.updateLeadStatus(lead.id, 'dnc');
    }

    await db.insertAuditLog(tenant_id, 'dnc_block', { phone: cleaned });
    await sendSlackNotification(`[DNC Block] outbound dial blocked to DNC number: ${cleaned}`);
    
    res.json({ success: true, message: `Phone ${cleaned} registered in DNC.` });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/dnc
 * Retrieves the DNC registry for the tenant.
 */
router.get('/dnc', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }
    const dncList = await db.getDncList(tenant_id);
    res.json({ success: true, dnc_registry: dncList });
  } catch (error) {
    next(error);
  }
});

/**
 * DELETE /leads/dnc/:phone
 * Removes a phone number from the DNC registry.
 */
router.delete('/dnc/:phone', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { phone } = req.params;
    if (!tenant_id || !phone) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id and phone are required' });
    }
    
    await db.removeDncNumber(tenant_id, phone);
    
    await db.insertAuditLog(tenant_id, 'dnc_remove', { phone });
    
    res.json({ success: true, message: `Phone ${phone} removed from DNC registry.` });
  } catch (error) {
    next(error);
  }
});


/**
 * GET /leads/scripts
 * Retrieves all scripts for a tenant.
 */
router.get('/scripts', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }
    const scripts = await db.getAllScripts(tenant_id);
    res.json({ success: true, scripts });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/scripts/:id
 * Retrieves a script by ID (UUID or script_id).
 */
router.get('/scripts/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    if (isUuid) {
      const scripts = await db.getAllScripts(req.tenant_id || 'default-tenant');
      const script = scripts.find(s => s.id === id);
      if (!script) {
        return res.status(404).json({ error: 'Not Found', message: `Script with ID ${id} not found.` });
      }
      return res.json({ success: true, script });
    } else {
      const { version  } = req.query;
    const tenant_id = req.tenant_id;
      if (!tenant_id) {
        return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required when searching by script_id' });
      }
      let script = null;
      if (version) {
        script = await db.getScript(tenant_id, id, version);
      } else {
        script = await db.getLatestScript(tenant_id, id);
      }
      if (!script) {
        return res.status(404).json({ error: 'Not Found', message: `Script with script_id ${id} not found.` });
      }
      return res.json({ success: true, script });
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/scripts
 * Validates and saves a script configuration.
 */
router.post('/scripts', async (req, res, next) => {
  try {
    const scriptData = req.body;
    const valResult = validateScript(scriptData);
    if (!valResult.isValid) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid script configuration',
        errors: valResult.errors
      });
    }

    const savedScript = await db.insertScript(scriptData);
    
    await db.insertAuditLog(scriptData.tenant_id, 'script_created', {
      script_id: savedScript.script_id,
      version: savedScript.version
    });

    res.status(201).json({ success: true, script: savedScript });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/handoff/brief/:lead_id
 * Serves agent brief context for the lead.
 */
router.get('/handoff/brief/:lead_id', async (req, res, next) => {
  try {
    const { lead_id } = req.params;
    let brief = await db.getAgentBrief(lead_id);
    const lead = await db.findLeadById(lead_id);
    
    if (!lead || lead.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }

    const tenantId = lead?.tenant_id || req.tenant_id;
    const sessions = tenantId ? await db.getCallSessionsByLeadId(lead_id, tenantId) : [];
    const latestSession = sessions[0];

    const raw = lead?.raw_data || {};
    const transcriptJson = latestSession?.transcript_json || raw.transcript_json || brief?.brief?.transcript_json || null;
    const recordingUrl = latestSession?.recording_url || latestSession?.audio_url || raw.recording_url || brief?.brief?.recording_url || null;
    const sentiment = latestSession?.sentiment || latestSession?.analysis?.sentiment || raw.sentiment || brief?.brief?.sentiment || 'neutral';
    const analysis = latestSession?.analysis || raw.analysis || brief?.brief?.analysis || {};

    if (!brief) {
      // Auto-generate / auto-heal brief for the lead
      let callSummary = latestSession?.summary || raw.summary;
      if (!callSummary) {
        if (lead.status === 'hot_escalated') {
          callSummary = JSON.stringify({
            call_purpose: `Outbound qualification for ${lead.campaign_name || 'General Campaign'}`,
            customer_response: 'Lead engaged and requested live human specialist intervention.',
            outcome: 'Escalation triggered. Hot prospect priority routing active.'
          });
        } else if (lead.status === 'called' || lead.status === 'completed') {
          callSummary = JSON.stringify({
            call_purpose: `Outbound qualification for ${lead.campaign_name || 'General Campaign'}`,
            customer_response: 'Prospect answered and completed qualification discussion.',
            outcome: 'Outbound call completed. Conversation and intent parameters recorded.'
          });
        } else if (lead.status === 'calling' || lead.status === 'queued') {
          callSummary = JSON.stringify({
            call_purpose: `Outbound qualification dialer active for ${lead.campaign_name || 'General Campaign'}`,
            customer_response: 'Dialing in progress or queued.',
            outcome: `Initial qualification score: ${lead.score || 0}/100.`
          });
        } else {
          callSummary = JSON.stringify({
            call_purpose: `Prospect inquiry for ${lead.campaign_name || 'General Campaign'}`,
            customer_response: 'Initial contact record created.',
            outcome: `Initial qualification score: ${lead.score || 0}/100.`
          });
        }
      }

      let keyPhrases = [];
      if (raw.brand_name) keyPhrases.push(`Brand: ${raw.brand_name}`);
      if (raw.product_type || lead.product_type) keyPhrases.push(`Product: ${raw.product_type || lead.product_type}`);
      if (raw.business_type || lead.business_type) keyPhrases.push(`Segment: ${raw.business_type || lead.business_type}`);
      if (raw.city || lead.city) keyPhrases.push(`Location: ${raw.city || lead.city}`);
      if (transcriptJson && Array.isArray(transcriptJson)) {
        transcriptJson.slice(0, 3).forEach(m => {
          const t = m.message || m.content || m.text;
          if (t && t.length > 5 && !keyPhrases.includes(t)) keyPhrases.push(t.substring(0, 40));
        });
      }
      if (keyPhrases.length === 0) {
        keyPhrases = ['Outbound qualification completed', 'Prospect contact established'];
      }

      let objections = [];
      if (raw.objections && Array.isArray(raw.objections)) {
        objections = raw.objections;
      }

      // Determine specialist recommended action based on lead score & status
      let recommendedAction = 'Contact the lead immediately by phone.';
      const score = lead.score || 0;
      if (lead.status === 'hot_escalated' || score >= 80) {
        recommendedAction = 'High-intent lead. Direct senior specialist outreach recommended immediately.';
      } else if (score >= 60) {
        recommendedAction = 'Qualified prospect. Proceed with outbound product pitch and schedule site visit or demo.';
      } else if (score >= 40) {
        recommendedAction = 'Warm lead. Share digital brochure and follow up via WhatsApp / voice touchpoint.';
      } else {
        recommendedAction = 'Cold lead. Enroll into automated re-engagement drip campaign.';
      }

      const briefData = {
        lead_name: deriveLeadDisplayName(lead),
        phone: lead.phone,
        email: lead.email || null,
        score: score,
        lead_score: score,
        status: lead.status,
        call_duration_seconds: latestSession?.call_duration_seconds || latestSession?.duration || raw.call_duration_seconds || 0,
        call_summary: callSummary,
        transcript_json: transcriptJson,
        recording_url: recordingUrl,
        sentiment: sentiment,
        analysis: analysis,
        key_phrases: keyPhrases,
        objections: objections,
        recommended_action: recommendedAction,
        escalation_reason: latestSession?.disposition || (lead.status === 'hot_escalated' ? 'Manual Handoff' : 'Standard Lead Qualification'),
        timestamp: new Date().toISOString()
      };

      try {
        if (lead.tenant_id) {
          await db.upsertAgentBrief(lead.tenant_id, lead_id, briefData);
        }
      } catch (saveErr) {
        console.warn(`[Brief Auto-Heal] Non-critical warning: failed to persist brief to agent_briefs table: ${saveErr.message}`);
      }
      brief = { brief: briefData };
    }

    // Merge latest live values from database and session
    const finalBrief = { ...(brief.brief || {}) };
    if (lead) {
      finalBrief.lead_name = finalBrief.lead_name || deriveLeadDisplayName(lead);
      finalBrief.phone = finalBrief.phone || lead.phone;
      finalBrief.email = finalBrief.email || lead.email || null;
      finalBrief.status = lead.status;
      if (finalBrief.score === undefined && lead.score !== undefined) finalBrief.score = lead.score;
      if (finalBrief.lead_score === undefined && lead.score !== undefined) finalBrief.lead_score = lead.score;
    }

    if (finalBrief.lead_score === undefined && finalBrief.score !== undefined) {
      finalBrief.lead_score = finalBrief.score;
    }
    if (finalBrief.score === undefined && finalBrief.lead_score !== undefined) {
      finalBrief.score = finalBrief.lead_score;
    }

    // Helper to evaluate if transcript object contains actual speech turns
    const hasTranscriptTurns = (t) => {
      if (!t) return false;
      if (Array.isArray(t)) return t.length > 0;
      if (typeof t === 'object') {
        if (Array.isArray(t.messages)) return t.messages.length > 0;
        if (Array.isArray(t.conversation)) return t.conversation.length > 0;
        if (Array.isArray(t.turns)) return t.turns.length > 0;
        return Object.keys(t).length > 0;
      }
      return typeof t === 'string' && t.trim().length > 0;
    };

    // Attach transcripts, session logs, recording, and telemetry
    if (!hasTranscriptTurns(finalBrief.transcript_json)) {
      if (hasTranscriptTurns(transcriptJson)) {
        finalBrief.transcript_json = transcriptJson;
      } else {
        // Fallback 1: check other sessions for this lead
        const sessionWithTranscript = sessions.find(s => hasTranscriptTurns(s.transcript_json));
        if (sessionWithTranscript) {
          finalBrief.transcript_json = sessionWithTranscript.transcript_json;
        } else if (hasTranscriptTurns(raw.transcript_json)) {
          // Fallback 2: check raw lead payload
          finalBrief.transcript_json = raw.transcript_json;
        } else {
          // Fallback 3: check recorded call events
          try {
            const events = await db.getCallEvents(tenantId);
            const leadEvents = events.filter(e => e.payload?.lead_id === lead_id || (latestSession && e.session_id === latestSession.id));
            const speechEvents = leadEvents.filter(e => e.payload && (e.payload.transcript || e.payload.message || e.payload.text));
            if (speechEvents.length > 0) {
              finalBrief.transcript_json = speechEvents.map(se => ({
                speaker: se.payload?.speaker || (se.event_type.includes('user') || se.event_type.includes('intent') ? 'Customer' : 'Agent'),
                role: (se.event_type.includes('user') || se.event_type.includes('intent')) ? 'user' : 'assistant',
                message: se.payload?.transcript || se.payload?.message || se.payload?.text || '',
                timestamp: se.timestamp || se.created_at || new Date().toISOString()
              }));
            }
          } catch(e) {}
        }
      }
    }

    // Live provider transcript on-demand query if missing or refresh requested
    const isMockSess = !latestSession?.provider_session_id || latestSession.provider_session_id.startsWith('mock-') || latestSession.provider_session_id.startsWith('sim-');
    if ((!hasTranscriptTurns(finalBrief.transcript_json) || req.query.refresh === 'true' || ['calling', 'in-progress'].includes(latestSession?.disposition)) && !isMockSess && latestSession?.provider_session_id) {
      try {
        let providerType = DEFAULT_PROVIDER;
        if (latestSession.campaign_id && db.supabase) {
          try {
            const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('id', latestSession.campaign_id).maybeSingle();
            if (camp?.voice_provider) providerType = camp.voice_provider;
          } catch (_) {}
        } else if (lead.campaign_name && db.supabase) {
          try {
            const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('name', lead.campaign_name).eq('tenant_id', tenantId).maybeSingle();
            if (camp?.voice_provider) providerType = camp.voice_provider;
          } catch (_) {}
        }
        const provider = await voiceProviderFactory.getProvider(tenantId, providerType);
        const artifacts = await provider.fetchArtifacts(latestSession.provider_session_id, latestSession);
        if (artifacts && (hasTranscriptTurns(artifacts.transcript) || artifacts.summary || (artifacts.disposition && artifacts.disposition !== 'calling'))) {
          if (hasTranscriptTurns(artifacts.transcript)) {
            finalBrief.transcript_json = artifacts.transcript;
            latestSession.transcript_json = artifacts.transcript;
          }
          if (artifacts.summary) {
            finalBrief.call_summary = artifacts.summary;
            latestSession.summary = artifacts.summary;
          }
          if (artifacts.recording_url) {
            finalBrief.recording_url = artifacts.recording_url;
            latestSession.recording_url = artifacts.recording_url;
          }
          if (artifacts.duration_seconds) {
            finalBrief.call_duration_seconds = artifacts.duration_seconds;
            latestSession.duration = artifacts.duration_seconds;
            latestSession.call_duration_seconds = artifacts.duration_seconds;
          }
          if (artifacts.sentiment) {
            finalBrief.sentiment = artifacts.sentiment;
            latestSession.sentiment = artifacts.sentiment;
          }
          if (artifacts.analysis) {
            finalBrief.analysis = artifacts.analysis;
            latestSession.analysis = artifacts.analysis;
          }
          if (artifacts.disposition && artifacts.disposition !== 'calling') {
            latestSession.disposition = artifacts.disposition;
            finalBrief.escalation_reason = artifacts.disposition;
          }

          const sessionUpdates = {
            transcript_json: artifacts.transcript || latestSession.transcript_json,
            recording_url: artifacts.recording_url || latestSession.recording_url,
            duration: artifacts.duration_seconds || latestSession.duration || 0,
            disposition: latestSession.disposition,
            summary: artifacts.summary || latestSession.summary,
            sentiment: artifacts.sentiment || latestSession.sentiment,
            analysis: artifacts.analysis || latestSession.analysis
          };
          if (latestSession.disposition !== 'calling' && !latestSession.ended_at) {
            sessionUpdates.ended_at = new Date().toISOString();
          }

          await db.updateCallSession(latestSession.id, sessionUpdates).catch(() => {});
          await db.upsertAgentBrief(tenantId, lead_id, finalBrief).catch(() => {});
        }
      } catch (err) {
        console.warn('[Brief] Error on-demand fetching transcript from provider:', err.message);
      }
    }

    if (!finalBrief.recording_url && recordingUrl) {
      finalBrief.recording_url = recordingUrl;
    }
    if (!finalBrief.sentiment && sentiment) {
      finalBrief.sentiment = sentiment;
    }
    if (!finalBrief.analysis || Object.keys(finalBrief.analysis).length === 0) {
      finalBrief.analysis = analysis;
    }
    
    // Accurate duration calculation
    if (!finalBrief.call_duration_seconds || finalBrief.call_duration_seconds === 0) {
      finalBrief.call_duration_seconds = latestSession?.duration || latestSession?.call_duration_seconds || raw.call_duration_seconds || 0;
      if (!finalBrief.call_duration_seconds && latestSession?.started_at && latestSession?.ended_at) {
        const diff = Math.max(0, Math.round((new Date(latestSession.ended_at) - new Date(latestSession.started_at)) / 1000));
        if (diff > 0 && diff < 3600) finalBrief.call_duration_seconds = diff;
      }
      if (!finalBrief.call_duration_seconds && Array.isArray(finalBrief.transcript_json) && finalBrief.transcript_json.length > 0) {
        finalBrief.call_duration_seconds = Math.min(300, finalBrief.transcript_json.length * 7);
      }
    }

    finalBrief.sessions = sessions.map(s => ({
      id: s.id,
      provider_session_id: s.provider_session_id,
      disposition: s.disposition,
      duration: s.duration || s.call_duration_seconds || 0,
      started_at: s.started_at,
      ended_at: s.ended_at,
      summary: s.summary,
      sentiment: s.sentiment || s.analysis?.sentiment || 'neutral',
      analysis: s.analysis || {},
      transcript_json: s.transcript_json,
      recording_url: s.recording_url || s.audio_url || null
    }));

    res.json({ success: true, brief: finalBrief });
  } catch (error) {
    console.error(`[GET /leads/handoff/brief/:lead_id] Error retrieving brief for lead ${req.params?.lead_id}:`, error);
    next(error);
  }
});


/**
 * POST /leads/handoff/escalate
 * Manually escalates a call session.
 */
router.post('/handoff/escalate', async (req, res, next) => {
  try {
    const { lead_id, provider_session_id, reason  } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id || !lead_id || !provider_session_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id, lead_id, and provider_session_id are required' });
    }

    const brief = await handleEscalation(provider_session_id, {
      payload: { reason: reason || 'Manual Handoff' }
    });

    res.json({ success: true, message: 'Session manually escalated.', brief });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/calls/instant
 * Immediately initiates a simulated call session, bypassing the queue capacity.
 * If at concurrent capacity, enqueues the lead with highest priority.
 */
router.post('/calls/instant', async (req, res, next) => {
  try {
    const { lead_id  } = req.body;
    const tenant_id = req.tenant_id;
    if (!tenant_id || !lead_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id and lead_id are required' });
    }

    const lead = await db.findLeadById(lead_id);
    if (!lead || lead.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }

    // DNC check
    const onboarding = await db.getOnboardingConfig(tenant_id);
    const usePlatformDnc = onboarding.dnc_validation_ownership !== 'client';
    const isDnc = await db.isDncNumber(tenant_id, lead.phone);
    const isDncMockPattern = lead.phone.includes('403') || lead.phone.includes('0000');

    if (usePlatformDnc && (isDnc || isDncMockPattern)) {
      await db.updateLeadStatus(lead_id, 'dnc');
      await db.insertAuditLog(tenant_id, 'dnc_block', { lead_id: lead.id, phone: lead.phone });
      await sendSlackNotification(`[DNC Block] Instant call blocked to DNC number: ${lead.phone}`);
      return res.status(400).json({ error: 'DNC Block', message: 'The number is registered on the national DNC database.' });
    }

    if (!isCallable(lead, onboarding)) {
      return res.status(400).json({ error: 'Outside Calling Hours', message: 'Calls are only permitted between 9 AM and 8 PM IST.' });
    }

    // Concurrency check
    const limit = onboarding.concurrent_call_limit || 5;
    const activeCalls = await db.getActiveCallsCount(tenant_id);
    console.log(`[Concurrency] limit: ${limit}, activeCalls: ${activeCalls}`);

    if (activeCalls >= limit) {
      // Concurrency full, enqueue at highest priority
      await db.updateLeadStatusAndData(lead_id, 'queued', {
        ...(lead.raw_data || {}),
        instant_requested_at: new Date().toISOString()
      });
      await db.updateLeadScore(lead_id, 999);
      await db.enqueueToDialer(tenant_id, lead_id, lead.phone, lead.campaign_name);
      
      await db.insertAuditLog(tenant_id, 'instant_call_queued', { lead_id, message: 'Concurrency limit reached, enqueued at highest priority.' });
      return res.json({ success: true, dial_mode: 'queued_high_priority', message: 'Concurrency limit reached. Enqueued at highest priority.' });
    }

    // Direct dialing
    await db.updateLeadStatus(lead_id, 'calling');
    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.get('host');
    const instantCampaigns = await db.getCampaigns(tenant_id);
    const instantCampaign = instantCampaigns.find(c => c.name === lead.campaign_name);
    const providerType = req.body.voice_provider || instantCampaign?.voice_provider || lead.voice_provider || onboarding?.aiAgent?.voiceProvider || DEFAULT_PROVIDER;
    const webhookPath = `/leads/webhook/${providerType}?tenant_id=${encodeURIComponent(tenant_id)}`;
    const webhookUrl = `${process.env.PUBLIC_APP_URL ? APP_URL() : `${protocol}://${host}`}${webhookPath}`;

    const provider = await voiceProviderFactory.getProvider(lead.tenant_id, providerType);
    const result = await provider.initSession(lead, { ...onboarding, voice_agent_id: req.body.voice_agent_id || instantCampaign?.voice_agent_id || null, campaign: instantCampaign }, webhookUrl);

    const session = await db.insertCallSession({
      tenant_id,
      lead_id,
      provider_session_id: result.provider_session_id,
      disposition: 'calling'
    });

    await db.insertAuditLog(tenant_id, 'call_initiated_instant', {
      lead_id,
      provider_session_id: result.provider_session_id,
      phone: lead.phone
    });

    res.json({ success: true, dial_mode: 'instant', provider_session_id: result.provider_session_id, session_id: session.id });
  } catch (error) {
    next(error);
  }
});




/**
 * GET /leads/analytics/summary

 * Aggregates dashboard analytics KPI cards and funnel metrics.
 */
async function computeDashboardAnalyticsData(tenant_id, campaign_id = null, date_range = "7d", graph_range = null) {
  if (!tenant_id) {
    throw new Error('tenant_id query parameter is required');
  }

  let leads = await db.getLeads(tenant_id);
  let sessions = await db.getCallSessions(tenant_id);
  
  const nowForPulse = new Date();
  const startOfDay = new Date(nowForPulse.getFullYear(), nowForPulse.getMonth(), nowForPulse.getDate());
  
  const onboardingConfig = await db.getOnboardingConfig(tenant_id);
  const hotThreshold = onboardingConfig?.thresholds?.hot || 80;

  // Using imported connectedDispositions
  const leadsMapAll = {};
  leads.forEach(l => {
    leadsMapAll[l.id] = l;
  });

  // Calculate campaign metadata if scoped
  let campaign_meta = null;
  if (campaign_id && campaign_id !== 'all') {
    let resolvedCampaignId = campaign_id;
    const allCampaigns = await db.getCampaigns(tenant_id);
    const matchedCampaign = allCampaigns.find(c => c.name.toLowerCase() === campaign_id.toLowerCase() || c.id === campaign_id);
    if (matchedCampaign) resolvedCampaignId = matchedCampaign.id;

    const campaignLeads = leads.filter(l => {
      if (l.raw_data?.campaign_id === campaign_id || l.raw_data?.campaign_id === resolvedCampaignId) return true;
      if (!l.campaign_name) return false;
      const cNames = l.campaign_name.split(',').map(c => c.trim().toLowerCase());
      return cNames.includes(campaign_id.toLowerCase()) || cNames.includes(resolvedCampaignId.toLowerCase());
    });
    if (campaignLeads.length > 0) {
       // Find oldest created_at for ingested
       let ingested = nowForPulse;
       let updated = new Date(0);
       campaignLeads.forEach(l => {
         const c = new Date(l.created_at || nowForPulse);
         const u = new Date(l.updated_at || l.created_at || nowForPulse);
         if (c < ingested) ingested = c;
         if (u > updated) updated = u;
       });
       campaign_meta = {
         id: campaign_id,
         name: campaign_id, // Use the requested campaign name directly — lead.campaign_name may be a comma-separated multi-campaign string
         status: matchedCampaign ? matchedCampaign.status : 'draft',
         max_concurrency: matchedCampaign ? matchedCampaign.max_concurrency : 3,
         channel: 'Voice',
         ingested_at: ingested.toISOString(),
         updated_at: updated.toISOString()
       };
    }
    
    leads = campaignLeads;
    const validLeadIds = new Set(campaignLeads.map(l => l.id));
    sessions = sessions.filter(s => validLeadIds.has(s.lead_id));
  }

  // Pre-filter Pulse (we need today's data for this specific scope)
  const todayLeads = leads.filter(l => new Date(l.created_at || nowForPulse) >= startOfDay);
  const todayLeadIds = new Set(todayLeads.map(l => l.id));
  const todaySessions = sessions.filter(s => todayLeadIds.has(s.lead_id));
  
  const pulse_today = {
    dialled: todaySessions.length,
    connected: todaySessions.filter(s => s.disposition && ['completed', 'won', 'interested', 'callback', 'failed'].includes(s.disposition.toLowerCase())).length,
    qualified: todayLeads.filter(l => l.score >= hotThreshold && l.status !== 'dnc' && todaySessions.some(s => s.lead_id === l.id && s.consent_status === 'agreed')).length,
    won: todayLeads.filter(l => l.status === 'won').length,
    active_campaigns: new Set(todayLeads.map(l => l.raw_data?.campaign_id || l.campaign_name).filter(Boolean)).size
  };

  const graphLeads = [...leads]; // Preserve leads for independent graph filter

  // Date Range Filtering
  // A lead counts as "in window" if ANY of these fall within the range:
  //   - created_at (original ingestion)
  //   - updated_at (any status change, including retry backoff / requalification)
  //   - last_call_at / raw_data.last_call_at (most recent dial attempt)
  // We also keep leads currently active in the dialer pipeline regardless of dates,
  // AND any lead that has a currently-active session (calling/dialing/in-progress) —
  // so a re-queued 'closed' lead whose original ingestion was 30 days ago still shows
  // up while it's actively being redialed.
  if (date_range !== "all") {
    const days = date_range === "7d" ? 7 : 30;
    const cutoff = new Date(nowForPulse.getTime() - days * 24 * 60 * 60 * 1000);
    const ACTIVE_LEAD_STATUSES = new Set([
      'queued', 're-queued', 'requeued', 'calling', 'dialing',
      'dispatched', 'in-progress', 'in_progress', 'scheduled', 'ringing'
    ]);
    const ACTIVE_SESSION_DISPOSITIONS = new Set([
      'calling', 'dialing', 'in-progress', 'in_progress', 'ringing'
    ]);
    const anyDateInWindow = (l) => {
      const candidates = [
        l.created_at,
        l.updated_at,
        l.last_call_at,
        l.raw_data?.last_call_at,
        l.raw_data?.updated_at
      ];
      for (const raw of candidates) {
        if (!raw) continue;
        const d = new Date(raw);
        if (!isNaN(d.getTime()) && d >= cutoff) return true;
      }
      // If no timestamp is present, fall back to keeping the lead (safer to over-include
      // than to silently drop it — same behavior as the pre-fix code when created_at was null).
      const anyPresent = candidates.some(v => !!v);
      return !anyPresent;
    };
    const activeSessionLeadIds = new Set(
      sessions
        .filter(s => ACTIVE_SESSION_DISPOSITIONS.has((s.disposition || '').toLowerCase()))
        .map(s => s.lead_id)
    );
    const withinWindowOrActive = (l) => {
      if (anyDateInWindow(l)) return true;
      const status = (l.status || '').toLowerCase();
      if (ACTIVE_LEAD_STATUSES.has(status)) return true;
      if (activeSessionLeadIds.has(l.id)) return true;
      return false;
    };
    leads = leads.filter(withinWindowOrActive);
    const leadIds = new Set(leads.map(l => l.id));
    sessions = sessions.filter(s => {
      if (leadIds.has(s.lead_id)) return true;
      const disp = (s.disposition || '').toLowerCase();
      if (ACTIVE_SESSION_DISPOSITIONS.has(disp)) return true;
      const sessionDate = new Date(s.started_at || s.created_at || 0);
      return !isNaN(sessionDate.getTime()) && sessionDate >= cutoff;
    });
    // Ensure every session's lead is represented in the leads set for downstream aggregates.
    for (const s of sessions) {
      if (!leadsMapAll[s.lead_id]) continue;
      if (!leads.find(l => l.id === s.lead_id)) leads.push(leadsMapAll[s.lead_id]);
    }
  }

  // Calculate top campaigns
  const campaignStats = {};
  leads.forEach(l => {
    const cId = l.raw_data?.campaign_id || l.campaign_name || 'unassigned';
    if (!campaignStats[cId]) {
      campaignStats[cId] = { campaign_id: cId, campaign_name: l.campaign_name || 'Unassigned', total_leads: 0, converted_leads: 0, hot_leads: 0, total_sessions: 0, connected_sessions: 0 };
    }
    campaignStats[cId].total_leads++;
    if (l.status === 'won') campaignStats[cId].converted_leads++;
    if (l.score >= hotThreshold) campaignStats[cId].hot_leads++;
  });
  
  sessions.forEach(s => {
    const lead = leadsMapAll[s.lead_id];
    const cId = lead ? (lead.raw_data?.campaign_id || lead.campaign_name || 'unassigned') : 'unassigned';
    if (!campaignStats[cId]) {
      campaignStats[cId] = { campaign_id: cId, campaign_name: lead?.campaign_name || 'Unassigned', total_leads: 0, converted_leads: 0, hot_leads: 0, total_sessions: 0, connected_sessions: 0 };
    }
    campaignStats[cId].total_sessions++;
    if (s.disposition && connectedDispositions.includes(s.disposition.toLowerCase())) {
      campaignStats[cId].connected_sessions++;
    }
  });

  const top_campaigns = Object.values(campaignStats).map(c => {
    return {
      campaign_id: c.campaign_id,
      campaign_name: c.campaign_name,
      connect_rate: c.total_sessions > 0 ? parseFloat(((c.connected_sessions / c.total_sessions) * 100).toFixed(1)) : 0.0,
      conversion_rate: c.total_leads > 0 ? parseFloat(((c.converted_leads / c.total_leads) * 100).toFixed(1)) : 0.0,
      hot_leads: c.hot_leads
    };
  });

  // Calculate 4 KPIs
  const totalLeads = leads.length;
  const hotLeads = leads.filter(l => l.score >= hotThreshold).length;
  const convertedCount = leads.filter(l => l.status === 'won').length;
  const connectedCalls = sessions.filter(s => s.disposition && connectedDispositions.includes(s.disposition.toLowerCase())).length;

  // Time boundaries for Deltas
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const computeDelta = (current, previous) => previous > 0 ? parseFloat((((current - previous) / previous) * 100).toFixed(1)) : (current > 0 ? 100.0 : 0.0);

  const leadsLast7d = leads.filter(l => new Date(l.created_at) >= sevenDaysAgo).length;
  const leadsPrev7d = leads.filter(l => new Date(l.created_at) >= fourteenDaysAgo && new Date(l.created_at) < sevenDaysAgo).length;
  const convertedLast7d = leads.filter(l => l.status === 'won' && new Date(l.updated_at) >= sevenDaysAgo).length;
  const convertedPrev7d = leads.filter(l => l.status === 'won' && new Date(l.updated_at) >= fourteenDaysAgo && new Date(l.updated_at) < sevenDaysAgo).length;
  const hotLast7d = leads.filter(l => l.score >= hotThreshold && new Date(l.updated_at) >= sevenDaysAgo).length;
  const hotPrev7d = leads.filter(l => l.score >= hotThreshold && new Date(l.updated_at) >= fourteenDaysAgo && new Date(l.updated_at) < sevenDaysAgo).length;
  const connectedLast7d = sessions.filter(s => s.disposition && connectedDispositions.includes(s.disposition.toLowerCase()) && new Date(s.started_at) >= sevenDaysAgo).length;
  const connectedPrev7d = sessions.filter(s => s.disposition && connectedDispositions.includes(s.disposition.toLowerCase()) && new Date(s.started_at) >= fourteenDaysAgo && new Date(s.started_at) < sevenDaysAgo).length;
  const callsLast7d = sessions.filter(s => new Date(s.started_at) >= sevenDaysAgo).length;
  const callsPrev7d = sessions.filter(s => new Date(s.started_at) >= fourteenDaysAgo && new Date(s.started_at) < sevenDaysAgo).length;

  const connectRateLast7d = callsLast7d > 0 ? (connectedLast7d / callsLast7d) * 100 : 0;
  const connectRatePrev7d = callsPrev7d > 0 ? (connectedPrev7d / callsPrev7d) * 100 : 0;

  const wonRateLast7d = connectedLast7d > 0 ? (convertedLast7d / connectedLast7d) * 100 : 0;
  const wonRatePrev7d = connectedPrev7d > 0 ? (convertedPrev7d / connectedPrev7d) * 100 : 0;


  const deltas = {
    total_leads: computeDelta(leadsLast7d, leadsPrev7d),
    connected: computeDelta(connectedLast7d, connectedPrev7d),
    converted: computeDelta(convertedLast7d, convertedPrev7d),
    hot_leads: computeDelta(hotLast7d, hotPrev7d),
    attempts: computeDelta(callsLast7d, callsPrev7d),
    connect_rate: connectRatePrev7d > 0 ? parseFloat((connectRateLast7d - connectRatePrev7d).toFixed(1)) : 0.0,
    won_rate: wonRatePrev7d > 0 ? parseFloat((wonRateLast7d - wonRatePrev7d).toFixed(1)) : 0.0
  };

  // leads_won_trend (Graph Range)
  const targetRange = graph_range || "weekly";
  let graphDays = 7;
  if (targetRange === "weekly") graphDays = 7;
  else if (targetRange === "monthly") graphDays = 30;
  else if (targetRange === "all-time") {
    let oldest = now.getTime();
    graphLeads.filter(l => l.status === 'won').forEach(l => {
      const ts = new Date(l.updated_at || l.created_at).getTime();
      if (ts < oldest) oldest = ts;
    });
    graphDays = Math.max(7, Math.ceil((now.getTime() - oldest) / (24 * 60 * 60 * 1000)) + 1);
  }

  const trendMap30 = {};
  for (let i = graphDays - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().substring(0, 10);
    trendMap30[dateStr] = 0;
  }
  
  graphLeads.filter(l => l.status === 'won').forEach(l => {
    const dateStr = new Date(l.updated_at || l.created_at).toISOString().substring(0, 10);
    if (trendMap30[dateStr] !== undefined) {
      trendMap30[dateStr]++;
    }
  });
  const leads_won_trend = Object.entries(trendMap30).map(([date, count]) => ({ date, count })).sort((a,b) => a.date.localeCompare(b.date));

  // Legacy variables for the rest of the return object
  const leadIdsWithConnectedSessions = new Set(
    sessions.filter(s => s.disposition && connectedDispositions.includes(s.disposition.toLowerCase()))
            .map(s => s.lead_id)
  );
  const qualifiedLeads = leads.filter(l => l.score >= hotThreshold && l.status !== 'dnc' && leadIdsWithConnectedSessions.has(l.id) && sessions.some(s => s.lead_id === l.id && s.consent_status === 'agreed')).length;
  const todayStr = new Date().toISOString().substring(0, 10);
  const todaySessionsLegacy = sessions.filter(s => s.started_at.substring(0, 10) === todayStr);
  const callsToday = todaySessionsLegacy.length;
  
  const totalCalls = sessions.length;
  const connectRate = totalCalls > 0 ? parseFloat(((connectedCalls / totalCalls) * 100).toFixed(1)) : 0.0;
  const wonRate = connectedCalls > 0 ? parseFloat(((convertedCount / connectedCalls) * 100).toFixed(1)) : 0.0;

  const funnel = {
    leads: totalLeads,
    total_attempts: totalCalls,
    attempted: new Set(sessions.map(s => s.lead_id)).size,
    connected: new Set(sessions.filter(s => s.disposition && connectedDispositions.includes(s.disposition.toLowerCase())).map(s => s.lead_id)).size,
    qualified: qualifiedLeads,
    won: convertedCount
  };

  const dispositionsMap = {};
  sessions.forEach(s => {
    if (s.disposition) {
      const d = s.disposition.toUpperCase();
      dispositionsMap[d] = (dispositionsMap[d] || 0) + 1;
    }
  });
  const dispositions = Object.entries(dispositionsMap).map(([name, value]) => ({ name, value }));

  const activeCalls = sessions.filter(s => s.disposition && ['calling', 'in_progress', 'live', 'ringing', 'queued'].includes(s.disposition.toLowerCase())).length;
  const activeAgents = activeCalls;

  // Attention Panel (3 rows each per spec)
  const top_hot_leads = leads
    .filter(l => l.score >= hotThreshold && l.status !== 'won' && l.status !== 'dnc')
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(l => ({ name: deriveLeadDisplayName(l), phone: l.phone, campaign: l.campaign_name || 'Unassigned', score: l.score }));

  const recent_escalations = sessions
    .filter(s => s.disposition === 'failed')
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
    .slice(0, 3)
    .map(s => {
       const l = leadsMapAll[s.lead_id];
       return { 
         lead_name: deriveLeadDisplayName(l),
         reason: s.failure_reason || s.disposition || 'Unknown', 
         detail: 'Max attempts reached', 
         time_ago: s.started_at 
       };
    });

  const failed_dnc_today = leads
    .filter(l => (l.status === 'dnc' || l.status === 'failed'))
    .sort((a, b) => new Date(b.updated_at || b.created_at) > new Date(a.updated_at || a.created_at) ? -1 : 1)
    .slice(0, 3)
    .map(l => ({ phone: (l.phone || '').substring(0, 4) + '*** ***' + (l.phone || '').substring((l.phone || '').length - 2), reason: l.status === 'dnc' ? 'DNC REGISTRY' : 'INVALID NUMBER' }));

  const failed_dnc_count = leads.filter(l => (l.status === 'dnc' || l.status === 'failed')).length;

  // Recent Calls (last 20 for this scope)
  const recent_calls = sessions
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
    .slice(0, 20)
    .map(s => {
      const l = leadsMapAll[s.lead_id];
      return {
        id: s.id,
        started_at: s.started_at,
        duration: s.duration || '00:00',
        disposition: s.disposition || 'Unknown',
        agent: s.agent_id || 'System',
        lead_name: deriveLeadDisplayName(l),
        lead_phone: l ? l.phone : 'Unknown'
      };
    });

  // Heatmap: 7 days x 12 hours (9a to 8p -> hour 9 to 20)
  const heatmap = [];
  for (let d = 0; d < 7; d++) {
    heatmap[d] = [];
    for (let h = 0; h < 12; h++) {
       heatmap[d][h] = { total: 0, connected: 0, rate: 0 };
    }
  }

  sessions.forEach(s => {
     if (!s.started_at) return;
     const dt = new Date(s.started_at);
     // getDay() is 0 (Sun) to 6 (Sat). We want Mon(0) to Sun(6).
     const d = (dt.getDay() + 6) % 7; 
     const hour = dt.getHours();
     if (hour >= 9 && hour <= 20) {
       const h = hour - 9;
       heatmap[d][h].total++;
       if (s.disposition && connectedDispositions.includes(s.disposition.toLowerCase())) {
         heatmap[d][h].connected++;
       }
     }
  });

  // Calculate rate
  for (let d = 0; d < 7; d++) {
    for (let h = 0; h < 12; h++) {
       if (heatmap[d][h].total > 0) {
          heatmap[d][h].rate = parseFloat(((heatmap[d][h].connected / heatmap[d][h].total) * 100).toFixed(1));
       }
    }
  }



  // Active Escalation — always search ALL leads (unscoped by filter) so the
  // banner is stable per user regardless of the current campaign / date filter.
  // Adds stable sort tiebreak by id so the same lead is picked every tick.
  let active_escalation = null;
  try {
    const allLeadsForEscalation = await db.getLeads(tenant_id);
    const active_escalation_lead = allLeadsForEscalation
      .filter(l => l.status === 'hot_escalated')
      .sort((a, b) => {
        const dt = new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0);
        if (dt !== 0) return dt;
        return String(a.id || '').localeCompare(String(b.id || ''));
      })[0];
    if (active_escalation_lead) {
      active_escalation = {
        id: active_escalation_lead.id,
        name: deriveLeadDisplayName(active_escalation_lead),
        reason: 'Requires immediate advisor brief lookup'
      };
    }
  } catch (err) {
    console.error("Error computing active_escalation:", err);
  }

  return {
    success: true,
    active_escalation,
    campaign_meta,
    pulse_today,
    attention: {
      hot_leads: top_hot_leads,
      escalations: recent_escalations,
      failed_dnc: failed_dnc_today,
      failed_dnc_count
    },
    kpis: {
      total_leads: totalLeads,
      connected: connectedCalls,
      won: convertedCount,
      hot_leads: hotLeads,
      attempts: totalCalls,
      connect_rate: connectRate,
      won_rate: wonRate,
      deltas,
      // Legacy
      active_agents: activeAgents
    },
    top_campaigns,
    leads_won_trend,
    funnel,
    recent_calls,
    heatmap,
    dispositions,
  };
}

router.get('/analytics/summary', async (req, res, next) => {
  try {
    if (!req.tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }
    const data = await computeDashboardAnalyticsData(
      req.tenant_id, 
      req.query.campaign_id || req.query.campaign, 
      req.query.date_range || "7d",
      req.query.graph_range || "weekly"
    );
    res.json(data);
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/analytics/stream
 * Real-time SSE stream for dashboard analytics.
 */
router.get('/analytics/stream', async (req, res) => {
  const tenant_id = req.tenant_id;
  const campaign_id = req.query.campaign_id || req.query.campaign;
  const date_range = req.query.date_range || "7d";
  const graph_range = req.query.graph_range || "weekly";
  if (!tenant_id) {
    return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Send initial data immediately
  try {
    const initialData = await computeDashboardAnalyticsData(tenant_id, campaign_id, date_range, graph_range);
    console.log("INITIAL:", JSON.stringify(initialData.kpis));
    res.write(`data: ${JSON.stringify(initialData)}\n\n`);
  } catch (err) {
    console.error('SSE initial data error:', err);
  }

  // Poll database every 5 seconds and push updates
  const intervalId = setInterval(async () => {
    try {
      const data = await computeDashboardAnalyticsData(tenant_id, campaign_id, date_range, graph_range);
      console.log("INTERVAL:", JSON.stringify(data.kpis));
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
      console.error('SSE interval data error:', err);
    }
  }, 5000);

  req.on('close', () => {
    clearInterval(intervalId);
    res.end();
  });
});

/**
 * GET /leads/scoring-config/:tenant_id
 */
router.get('/scoring-config/:tenant_id', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const weights = await db.getWeights(tenant_id);
    res.json({ success: true, tenant_id, weights });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/scoring-config/:tenant_id
 */
router.post('/scoring-config/:tenant_id', async (req, res, next) => {
  try {
    const tenant_id = req.tenant_id;
    const { weights, changed_by } = req.body;
    const valResult = validateScoringWeights(weights);
    if (!valResult.isValid) {
      return res.status(400).json({ error: 'Validation Error', message: 'Invalid scoring weights', errors: valResult.errors });
    }
    await db.upsertWeights(tenant_id, weights, changed_by || 'system');
    res.json({ success: true, tenant_id, weights });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/:id/sessions
 * Retrieves call sessions, WhatsApp/message logs, and disposition history for a specific lead.
 */
router.get('/:id/sessions', async (req, res, next) => {
  try {
    const { id } = req.params;
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id query parameter is required' });
    }

    const lead = await db.findLeadById(id);
    if (!lead) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }
    if (lead.tenant_id !== req.tenant_id && !req.user?.isSuperAdmin) {
      return res.status(403).json({ success: false, error: 'forbidden' });
    }

    const effectiveTenant = lead.tenant_id || tenant_id;
    // Direct indexed query by lead_id (sub-millisecond, avoids full-table scan)
    let sessions = await db.getCallSessionsByLeadId(id, effectiveTenant);

    // Auto-reconciliation: If session is missing transcript or still in calling/in-progress, fetch artifacts from the provider
    for (const s of sessions) {
      const isSimulated = !s.provider_session_id ||
        s.provider_session_id.startsWith('mock-') ||
        s.provider_session_id.startsWith('sim-') ||
        s.provider_session_id.startsWith('pending-');

      const needsReconcile = (!s.transcript_json || req.query.refresh === 'true' || ['calling', 'in-progress', 'in_progress'].includes(s.disposition)) && !isSimulated;

      if (needsReconcile) {
        try {
          let providerType = DEFAULT_PROVIDER;
          if (s.campaign_id && db.supabase) {
            try {
              const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('id', s.campaign_id).maybeSingle();
              if (camp?.voice_provider) providerType = camp.voice_provider;
            } catch (_) {}
          } else if (lead.campaign_name && db.supabase) {
            try {
              const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('name', lead.campaign_name).eq('tenant_id', lead.tenant_id).maybeSingle();
              if (camp?.voice_provider) providerType = camp.voice_provider;
            } catch (_) {}
          }
          const provider = await voiceProviderFactory.getProvider(lead.tenant_id, providerType);
          const artifacts = await provider.fetchArtifacts(s.provider_session_id, s);
          if (artifacts && (artifacts.transcript || artifacts.summary || (artifacts.disposition && artifacts.disposition !== 'calling'))) {
            if (artifacts.transcript) s.transcript_json = artifacts.transcript;
            if (artifacts.summary) s.summary = artifacts.summary;
            if (artifacts.recording_url) s.recording_url = artifacts.recording_url;
            if (artifacts.duration_seconds) s.duration = artifacts.duration_seconds;
            if (artifacts.sentiment) s.sentiment = artifacts.sentiment;
            if (artifacts.analysis) s.analysis = artifacts.analysis;
            if (artifacts.disposition && artifacts.disposition !== 'calling') {
              s.disposition = artifacts.disposition;
            } else if (artifacts.transcript && s.disposition === 'calling') {
              s.disposition = 'completed';
            }

            const updates = {
              transcript_json: s.transcript_json,
              summary: s.summary,
              recording_url: s.recording_url,
              duration: s.duration,
              sentiment: s.sentiment,
              analysis: s.analysis,
              disposition: s.disposition
            };
            await db.updateCallSession(s.id, updates).catch(e => console.warn('[GET sessions] Persist to call_sessions failed:', e.message));

            const raw = lead.raw_data || {};
            if (s.transcript_json) raw.transcript_json = s.transcript_json;
            if (s.summary) raw.summary = s.summary;
            if (s.recording_url) raw.recording_url = s.recording_url;
            if (s.duration) raw.call_duration_seconds = s.duration;
            if (s.sentiment) raw.sentiment = s.sentiment;
            if (s.analysis) raw.analysis = s.analysis;
            if (s.provider_session_id) raw.provider_session_id = s.provider_session_id;

            const leadUpdates = { raw_data: raw };
            if (['calling', 'queued', 'in_progress'].includes(lead.status)) {
              leadUpdates.status = s.disposition === 'hot_escalated' ? 'hot_escalated' : 'called';
              lead.status = leadUpdates.status;
            }
            await db.updateLead(id, leadUpdates).catch(e => console.warn('[GET sessions] Lead raw_data update failed:', e.message));
          }
        } catch (fetchErr) {
          console.warn('[GET sessions] provider artifact fetch failed (non-fatal):', fetchErr.message);
        }
      }

      // Sync lead status if session already finished
      if (['completed', 'called', 'hot_escalated'].includes(s.disposition) && ['calling', 'queued'].includes(lead.status)) {
        const newStatus = s.disposition === 'hot_escalated' ? 'hot_escalated' : 'called';
        await db.updateLead(id, { status: newStatus }).catch(e => {});
        lead.status = newStatus;
      }

      // Fallback: Populate missing fields from lead.raw_data if available
      if (!s.transcript_json && lead.raw_data?.transcript_json) {
        s.transcript_json = lead.raw_data.transcript_json;
      }
      if (!s.recording_url && lead.raw_data?.recording_url) {
        s.recording_url = lead.raw_data.recording_url;
      }
      if (!s.duration && lead.raw_data?.call_duration_seconds) {
        s.duration = lead.raw_data.call_duration_seconds;
      }
      if (!s.summary && lead.raw_data?.summary) {
        s.summary = lead.raw_data.summary;
      }
      if (!s.sentiment && lead.raw_data?.sentiment) {
        s.sentiment = lead.raw_data.sentiment;
      }
      if ((!s.analysis || Object.keys(s.analysis).length === 0) && lead.raw_data?.analysis) {
        s.analysis = lead.raw_data.analysis;
      }
    }

    if (sessions.length === 0 && (lead.raw_data?.provider_session_id || lead.raw_data?.transcript_json || lead.status === 'called' || lead.status === 'hot_escalated' || lead.status === 're-queued' || lead.raw_data?.last_call_at)) {
      const brief = await db.getAgentBrief(id);
      let trans = lead.raw_data?.transcript_json || brief?.brief?.transcript_json || null;
      let summ = lead.raw_data?.summary || brief?.brief?.call_summary || (lead.status === 'hot_escalated' ? 'Escalation triggered by prospect.' : lead.status === 're-queued' ? 'Outbound call attempt completed.' : 'Qualification discussion completed.');
      let recUrl = lead.raw_data?.recording_url || brief?.brief?.recording_url || null;
      let dur = lead.raw_data?.call_duration_seconds || brief?.brief?.call_duration_seconds || 45;
      let sent = lead.raw_data?.sentiment || brief?.brief?.sentiment || 'neutral';
      let ana = lead.raw_data?.analysis || brief?.brief?.analysis || {};
      let disp = lead.raw_data?.last_disposition || (lead.status === 'hot_escalated' ? 'hot_escalated' : (lead.status === 'called' ? 'completed' : lead.status === 're-queued' ? 're-queued' : 'completed'));
      const providerSessId = lead.raw_data?.provider_session_id;

      if (providerSessId && !providerSessId.startsWith('mock-') && !providerSessId.startsWith('sim-') && !providerSessId.startsWith('pending-') && (!trans || req.query.refresh === 'true')) {
        try {
          let providerType = DEFAULT_PROVIDER;
          if (lead.campaign_id && db.supabase) {
            try {
              const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('id', lead.campaign_id).maybeSingle();
              if (camp?.voice_provider) providerType = camp.voice_provider;
            } catch (_) {}
          } else if (lead.campaign_name && db.supabase) {
            try {
              const { data: camp } = await db.supabase.from('campaigns').select('voice_provider').eq('name', lead.campaign_name).eq('tenant_id', lead.tenant_id).maybeSingle();
              if (camp?.voice_provider) providerType = camp.voice_provider;
            } catch (_) {}
          }
          const provider = await voiceProviderFactory.getProvider(lead.tenant_id, providerType);
          const artifacts = await provider.fetchArtifacts(providerSessId);
          if (artifacts && (artifacts.transcript || artifacts.summary)) {
            if (artifacts.transcript) trans = artifacts.transcript;
            if (artifacts.summary) summ = artifacts.summary;
            if (artifacts.recording_url) recUrl = artifacts.recording_url;
            if (artifacts.duration_seconds) dur = artifacts.duration_seconds;
            if (artifacts.sentiment) sent = artifacts.sentiment;
            if (artifacts.analysis) ana = artifacts.analysis;
            if (artifacts.disposition) disp = artifacts.disposition;
          }
        } catch (e) {
          console.warn('[GET sessions] provider fetch for auto-session failed:', e.message);
        }
      }

      sessions.push({
        id: `sess-auto-${id}`,
        lead_id: id,
        tenant_id: effectiveTenant,
        provider_session_id: providerSessId || `sim-${id.substring(0, 8)}`,
        disposition: disp,
        duration: dur,
        started_at: lead.raw_data?.last_call_at || lead.updated_at || lead.created_at,
        ended_at: new Date(new Date(lead.raw_data?.last_call_at || lead.updated_at || lead.created_at).getTime() + (dur * 1000 || 45000)).toISOString(),
        summary: summ,
        transcript_json: trans,
        recording_url: recUrl,
        sentiment: sent,
        analysis: ana
      });
    }

    // Fetch actual interactions from the audit trail
    const auditEvents = await db.getLeadInteractions(tenant_id, id);
    
    // Separate message logs and disposition logs from audit events
    const realMessages = auditEvents
      .filter(e => e.event_type === 'whatsapp_message' || e.event_type === 'sms_message')
      .map(e => ({
        id: e.id,
        type: e.event_type === 'whatsapp_message' ? 'whatsapp' : 'sms',
        direction: e.details.direction || 'sent',
        sender: e.details.sender || 'system',
        body: e.details.body || '',
        timestamp: e.created_at || e.timestamp,
        status: e.details.status || 'delivered'
      }));

    const realDispositions = auditEvents
      .filter(e => e.event_type === 'disposition_changed' || e.event_type === 'lead_ingested' || e.event_type === 'lead_enqueued')
      .map(e => {
        let old_status = 'unknown';
        let new_status = 'unknown';
        let reason = '';
        if (e.event_type === 'lead_ingested') {
          old_status = '-';
          new_status = 'ingested';
          reason = 'Lead ingested from source';
        } else if (e.event_type === 'lead_enqueued') {
          old_status = 'ingested';
          new_status = 'queued';
          reason = 'Added to outbound dialer queue';
        } else {
          old_status = e.details.old_status || 'unknown';
          new_status = e.details.new_status || 'unknown';
          reason = e.details.reason || `Status updated from ${old_status} to ${new_status}`;
        }
        return {
          id: e.id,
          old_status,
          new_status,
          changed_at: e.created_at || e.timestamp,
          reason
        };
      });

    // Helper functions for mock data generation if database is empty
    const generateMockMessagesForLead = (ld, sess) => {
      const msgs = [];
      const name = ld.name || 'Customer';
      const phone = ld.phone;
      const createdAt = new Date(ld.created_at || Date.now() - 3600000 * 24);

      msgs.push({
        id: 'msg-mock-1',
        type: 'whatsapp',
        direction: 'sent',
        sender: 'system',
        body: `Hello ${name}, thank you for your interest in our B.Tech Admissions programs. A representative will contact you shortly on ${phone}.`,
        timestamp: new Date(createdAt.getTime() + 5 * 60 * 1000).toISOString(),
        status: 'read'
      });

      sess.forEach((s, idx) => {
        const sessionTime = new Date(s.started_at);
        if (s.disposition === 'no_answer' || s.disposition === 'busy' || s.disposition === 'failed') {
          msgs.push({
            id: `msg-mock-session-fail-${idx}`,
            type: 'whatsapp',
            direction: 'sent',
            sender: 'system',
            body: `Hi ${name}, we tried calling you but couldn't connect. Let us know a convenient time to call you back.`,
            timestamp: new Date(sessionTime.getTime() + 10 * 60 * 1000).toISOString(),
            status: 'read'
          });
          msgs.push({
            id: `msg-mock-session-fail-reply-${idx}`,
            type: 'whatsapp',
            direction: 'received',
            sender: 'customer',
            body: `I am busy now. Please try calling me after some time.`,
            timestamp: new Date(sessionTime.getTime() + 25 * 60 * 1000).toISOString(),
            status: 'read'
          });
        } else if (s.disposition === 'called' || s.disposition === 'qualified' || s.disposition === 'won' || s.disposition === 'hot_escalated') {
          msgs.push({
            id: `msg-mock-session-succ-${idx}`,
            type: 'whatsapp',
            direction: 'sent',
            sender: 'system',
            body: `Hi ${name}, thank you for speaking with us. As requested, we have registered your preference for ${ld.raw_data?.property_type || '3BHK properties'}. We'll keep you posted.`,
            timestamp: new Date(sessionTime.getTime() + 15 * 60 * 1000).toISOString(),
            status: 'delivered'
          });
        }
      });
      return msgs;
    };

    const generateMockDispositionsForLead = (ld, sess) => {
      const disps = [];
      const createdAt = new Date(ld.created_at || Date.now() - 3600000 * 24);

      disps.push({
        id: 'disp-mock-1',
        old_status: '-',
        new_status: 'ingested',
        changed_at: createdAt.toISOString(),
        reason: `Lead ingested from source: ${ld.source}`
      });

      disps.push({
        id: 'disp-mock-2',
        old_status: 'ingested',
        new_status: 'queued',
        changed_at: new Date(createdAt.getTime() + 10 * 60 * 1000).toISOString(),
        reason: 'Automatically enqueued for outbound dialing'
      });

      sess.forEach((s, idx) => {
        const sessionTime = s.started_at ? new Date(s.started_at) : new Date();
        const sessId = (s.provider_session_id || s.id || `sess-${idx}`).toString();
        const dispText = (s.disposition || 'in-progress').toString();

        disps.push({
          id: `disp-mock-session-start-${idx}`,
          old_status: idx === 0 ? 'queued' : 're-queued',
          new_status: 'calling',
          changed_at: sessionTime.toISOString(),
          reason: `Outbound call session initiated (Session ID: ${sessId.substring(0, 8)}...)`
        });

        const endTime = s.ended_at ? new Date(s.ended_at) : new Date(sessionTime.getTime() + 30 * 1000);
        const finalStatus = dispText.toLowerCase().includes('escalated') ? 'hot_escalated' : (dispText.toLowerCase() === 'called' || dispText.toLowerCase() === 'completed') ? 'called' : 're-queued';
        
        disps.push({
          id: `disp-mock-session-end-${idx}`,
          old_status: 'calling',
          new_status: finalStatus,
          changed_at: endTime.toISOString(),
          reason: `Call ended. Disposition logged: ${dispText.toUpperCase()}`
        });
      });

      if (ld.status === 'hot_escalated' && !disps.some(d => d.new_status === 'hot_escalated')) {
        disps.push({
          id: 'disp-mock-esc',
          old_status: ld.status === 'called' ? 'called' : 'queued',
          new_status: 'hot_escalated',
          changed_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
          reason: 'AI detected hot qualification signals and escalated lead'
        });
      }
      return disps;
    };

    const mockMessages = generateMockMessagesForLead(lead, sessions);
    const mockDispositions = generateMockDispositionsForLead(lead, sessions);

    // Merge real and mock (prevent duplicates)
    const messages = [...realMessages];
    mockMessages.forEach(m => {
      if (!messages.some(rm => rm.body === m.body)) {
        messages.push(m);
      }
    });
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

    const dispositions = [...realDispositions];
    mockDispositions.forEach(d => {
      if (!dispositions.some(rd => rd.reason === d.reason)) {
        dispositions.push(d);
      }
    });
    dispositions.sort((a, b) => new Date(a.changed_at) - new Date(b.changed_at));

    res.json({
      success: true,
      sessions,
      messages,
      dispositions
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/:id/messages
 * Sends a message (WhatsApp or SMS) to a lead, records it in audit_trail,
 * and schedules a mock user response for interactive testing.
 */
router.post('/:id/messages', async (req, res, next) => {
  try {
    const { id } = req.params;
    const { type, body  } = req.body;
    const tenant_id = req.tenant_id;
    
    if (!tenant_id || !type || !body) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id, type, and body are required' });
    }

    if (type === 'whatsapp' && !WHATSAPP_ENABLED) {
      return res.status(503).json({ error: 'Service Unavailable', message: 'WhatsApp integration is disabled for this release.' });
    }
    const lead = await db.findLeadById(id);
    if (!lead || lead.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }

    // Insert the outgoing message
    const outgoing = await db.insertAuditLog(tenant_id, type === 'whatsapp' ? 'whatsapp_message' : 'sms_message', {
      lead_id: id,
      direction: 'sent',
      sender: 'system',
      body,
      status: 'delivered'
    });

    // Generate a mock response after 1.5 seconds if in mock/test mode
    setTimeout(async () => {
      try {
        const replies = [
          "Sure, thank you for sharing details.",
          "I will review the brochure and get back to you.",
          "Can you call me tomorrow morning instead?",
          "Yes, please send me the branch location.",
          "Perfect, thanks for the update!"
        ];
        const randomReply = replies[Math.floor(Math.random() * replies.length)];
        
        await db.insertAuditLog(tenant_id, type === 'whatsapp' ? 'whatsapp_message' : 'sms_message', {
          lead_id: id,
          direction: 'received',
          sender: 'customer',
          body: randomReply,
          status: 'read'
        });
      } catch (err) {
        console.error('Error recording mock customer response:', err);
      }
    }, 1500);

    res.json({ success: true, message: 'Message sent successfully.', message_id: outgoing.id });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/campaign/:campaign_name/dial-all
 * Triggers batch dialing for all leads in a campaign, setting threshold and concurrency limits.
 */
router.post('/campaign/:campaign_name/dial-all', async (req, res, next) => {
  try {
    const { campaign_name } = req.params;
    const { whatsapp_threshold, max_concurrency } = req.body || {};
    const tenant_id = req.tenant_id;

    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }
    const thresholdVal = whatsapp_threshold !== undefined ? parseInt(whatsapp_threshold) : 70;
    const concurrencyVal = max_concurrency !== undefined ? parseInt(max_concurrency) : 3;

    const limitParam = req.query.limit !== undefined && req.query.limit !== '' ? parseInt(req.query.limit, 10) : null;
    const isDryRun = String(req.query.dry_run || req.body?.dry_run).toLowerCase() === 'true';

    try {
      const result = await dialAllCampaignLeads(tenant_id, campaign_name, thresholdVal, concurrencyVal, limitParam, isDryRun);
      return res.json(result);
    } catch (err) {
      if (err.message.includes('already triggered')) {
        return res.status(429).json({ error: err.message, hint: 'Wait 30s and try again' });
      }
      throw err;
    }
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/campaign/:campaign_name/pause
 * Pauses all queued calls for a campaign without terminating active calls.
 * The dispatcher skips rows with status='paused' so dialing stops immediately.
 */
router.post('/campaign/:campaign_name/pause', async (req, res, next) => {
  try {
    const { campaign_name } = req.params;
    const tenant_id = req.tenant_id;

    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }

    // 1. Mark the campaign as paused
    const campaigns = await db.getCampaigns(tenant_id);
    const campaign = campaigns.find(c => c.name.toLowerCase() === campaign_name.toLowerCase());
    if (campaign) {
      await db.updateCampaign(campaign.id, { status: 'paused' });

      // 2. Set all queued/re-queued rows in call_queue to 'paused' so dispatcher skips them
      if (db.supabase) {
        const { error: pauseErr } = await db.supabase
          .from('call_queue')
          .update({ status: 'paused' })
          .eq('tenant_id', tenant_id)
          .eq('campaign_id', campaign.id)
          .in('status', ['queued']);

        if (pauseErr) {
          console.error('[Pause] Failed to pause call_queue rows:', pauseErr);
        }
      }
    }

    console.log(`[Campaign Pause] Campaign "${campaign_name}" paused by tenant ${tenant_id}`);
    await sendSlackNotification(`⏸️ *[Campaign Paused]* Outbound dialing paused for "*${campaign_name}*". Active calls will finish naturally.`);

    res.json({
      success: true,
      message: `Campaign "${campaign_name}" paused. Active calls will finish naturally.`,
      campaign_name
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/campaign/:campaign_name/resume
 * Resumes a paused campaign by re-queuing all paused call_queue rows.
 */
router.post('/campaign/:campaign_name/resume', async (req, res, next) => {
  try {
    const { campaign_name } = req.params;
    const tenant_id = req.tenant_id;

    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }

    // 1. Set campaign back to active
    const campaigns = await db.getCampaigns(tenant_id);
    const campaign = campaigns.find(c => c.name.toLowerCase() === campaign_name.toLowerCase());
    let resumedCount = 0;
    if (campaign) {
      await db.updateCampaign(campaign.id, { status: 'active' });

      // 2. Flip paused rows back to queued so the dispatcher picks them up
      if (db.supabase) {
        const { data: resumed, error: resumeErr } = await db.supabase
          .from('call_queue')
          .update({ status: 'queued', next_attempt_at: new Date().toISOString() })
          .eq('tenant_id', tenant_id)
          .eq('campaign_id', campaign.id)
          .eq('status', 'paused')
          .select('queue_id');

        if (resumeErr) {
          console.error('[Resume] Failed to resume call_queue rows:', resumeErr);
        } else {
          resumedCount = resumed?.length || 0;
        }
      }
    }

    console.log(`[Campaign Resume] Campaign "${campaign_name}" resumed — ${resumedCount} rows re-queued`);
    await sendSlackNotification(`▶️ *[Campaign Resumed]* Outbound dialing resumed for "*${campaign_name}*" (${resumedCount} contacts re-queued).`);

    res.json({
      success: true,
      message: `Campaign "${campaign_name}" resumed. ${resumedCount} contacts re-queued for dialing.`,
      campaign_name,
      resumed_count: resumedCount
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /leads/campaign/:campaign_name/dialer-status
 * Polls status metrics of all leads in a campaign.
 */
router.get('/campaign/:campaign_name/dialer-status', async (req, res, next) => {
  try {
    const { campaign_name } = req.params;
    const tenant_id = req.tenant_id;

    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }

    const normalizedTarget = decodeURIComponent(campaign_name).trim().toLowerCase();
    const campaigns = await db.getCampaigns(tenant_id);
    const campaign = campaigns.find(c => 
      c.id === campaign_name || 
      c.name.toLowerCase() === normalizedTarget ||
      c.name.toLowerCase().replace(/\s+/g, '') === normalizedTarget.replace(/\s+/g, '')
    );
    const targetName = campaign ? campaign.name.toLowerCase() : normalizedTarget;

    // 1. Fetch leads and filter
    const campaignLeads = campaign
      ? await db.getLeadsForCampaign(tenant_id, campaign.id)
      : [];

    // Outbound API fallback for active call sessions (checks remote status to prevent stuck calls)
    const sessions = await db.getCallSessions(tenant_id);
    const activeSessions = sessions.filter(s => 
      s.disposition === 'calling' || 
      s.disposition === 'in-progress' ||
      s.disposition === 'in_progress'
    );

    // Active calls are reconciled by the dispatcher's stale-call reaper and by provider webhooks.
    void activeSessions;

    const totalLeads = campaignLeads.length;
    const queuedLeads = campaignLeads.filter(l => l.status === 'queued' || l.status === 're-queued').length;
    const activeLeads = campaignLeads.filter(l => l.status === 'calling' || l.status === 'in-progress').length;
    
    const completedDials = campaignLeads.filter(l => 
      ['called', 'completed', 'interested', 'enrolled', 'hot_escalated', 'closed', 'failed', 're-queued'].includes(l.status?.toLowerCase())
    ).length;

    // Calculate details for each lead to update UI table dynamically
    const leadDetails = campaignLeads.map(l => ({
      id: l.id,
      name: l.name,
      phone: l.phone,
      score: l.score || 0,
      status: l.status,
      updated_at: l.updated_at
    }));

    const unattemptedLeads = campaignLeads.filter(l => 
      ['ingested', 'new', 'draft', null, undefined].includes(l.status?.toLowerCase()) || !l.status
    ).length;

    // Mark campaign as completed in DB ONLY when ALL leads are dialed (no queued, no active, no unattempted)
    const isActuallyComplete = campaign && campaign.status === 'active' && totalLeads > 0 && queuedLeads === 0 && activeLeads === 0 && unattemptedLeads === 0 && completedDials > 0;
    if (isActuallyComplete) {
      const { checkAndNotifyCampaignCompletion } = await import('../services/campaignDialer.js');
      await checkAndNotifyCampaignCompletion(campaign.id).catch(err => console.warn('[Dialer Status] checkAndNotifyCampaignCompletion error:', err.message));
    }

    res.json({
      success: true,
      campaign_name,
      campaign_status: isActuallyComplete ? 'completed' : (campaign?.status || 'active'),
      total_leads: totalLeads,
      queued_leads: queuedLeads,
      active_leads: activeLeads,
      completed_leads: completedDials,
      leads: leadDetails
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /leads/:id/notes
 * Adds a new internal agent note to the lead.
 */
router.post('/:id/notes', async (req, res, next) => {
  try {
    const { id } = req.params;
    const rawText = req.body?.note_text || '';
    const note_text = rawText.trim();
    const tenant_id = req.tenant_id;
    if (!tenant_id || !note_text) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id and non-empty note_text are required' });
    }
    const lead = await db.findLeadById(id);
    if (!lead || lead.tenant_id !== req.tenant_id) {
      return res.status(404).json({ success: false, error: 'lead_not_found' });
    }

    const authorAgent = req.body?.agent_id || req.user?.email || req.user?.id || 'Agent';
    const newNote = await db.insertLeadNote(tenant_id, id, note_text, authorAgent);
    
    // Non-blocking audit log
    db.insertAuditLog(tenant_id, 'agent_note_added', { lead_id: id, agent_id: authorAgent, note_text }).catch(e => {
      console.warn('[POST /:id/notes] Audit log warning:', e.message);
    });

    res.status(201).json({ success: true, note: newNote });
  } catch (error) {
    console.error('[POST /:id/notes] Error:', error);
    next(error);
  }
});

/**
 * GET /leads/:id/notes
 * Retrieves internal agent notes for the lead.
 */
router.get('/:id/notes', async (req, res, next) => {
  try {
    const { id } = req.params;
    const tenant_id = req.tenant_id;
    if (!tenant_id) {
      return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required' });
    }

    const notes = await db.getLeadNotes(tenant_id, id);
    res.json({ success: true, notes: notes || [] });
  } catch (error) {
    console.error('[GET /:id/notes] Error:', error.message);
    res.json({ success: true, notes: [] });
  }
});


/**
 * POST /leads/webhook/:provider   (e.g. /leads/webhook/gnani)
 * Generic webhook: the voice provider calls this with call results.
 * The provider adapter's parseWebhook() turns the body into the standard shape.
 */
router.post('/webhook/:provider', express.raw({ type: 'application/json', limit: '10mb' }), async (req, res, next) => {
  const providerType = String(req.params.provider || '').toLowerCase();
  const rawBodyString = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {}));
  let parsedBody = {};
  try { parsedBody = JSON.parse(rawBodyString || '{}'); } catch (_) { parsedBody = {}; }

  try {
    if (!voiceProviderFactory.SUPPORTED_PROVIDERS.includes(providerType)) {
      return res.status(404).json({ error: `Unknown provider: ${providerType}` });
    }

    // Tenant: query string (set by the dispatcher) → header → body metadata
    const tenantHint = req.query.tenant_id || req.headers['x-tenant-id'] || parsedBody?.tenant_id || parsedBody?.metadata?.tenant_id || null;
    const provider = await voiceProviderFactory.getProvider(tenantHint, providerType);

    const normalized = await provider.parseWebhook(req, rawBodyString);
    if (!normalized) {
      return res.status(401).json({ error: 'Unauthorized: Invalid signature' });
    }

    const providerSessionId = normalized.session_id;
    const leadId = normalized.payload?.lead_id || null;

    let session = providerSessionId ? await db.findCallSessionByProviderId(providerSessionId) : null;
    if (!session && leadId && db.supabase) {
      try {
        const { data: leadSessions } = await db.supabase
          .from('call_sessions')
          .select('*')
          .eq('lead_id', leadId)
          .order('created_at', { ascending: false })
          .limit(1);
        if (leadSessions && leadSessions.length > 0) session = leadSessions[0];
      } catch (_) {}
    }

    const tenant_id = tenantHint || session?.tenant_id;
    if (!session && leadId && tenant_id) {
      try {
        session = await db.insertCallSession({
          tenant_id,
          lead_id: leadId,
          provider_session_id: providerSessionId,
          disposition: normalized.payload?.disposition || 'calling'
        });
      } catch (_) {}
    }

    if (!session) {
      console.warn(`[Webhook:${providerType}] Unknown session ${providerSessionId}`);
      return res.status(404).json({ error: 'Unknown session' });
    }

    await db.insertCallEvent({ ...normalized, tenant_id: session.tenant_id, session_id: session.id }).catch(() => {});

    return await processVoiceStreamEvent(session.tenant_id, session, normalized.event_type, parsedBody, normalized.payload, provider, providerSessionId, res, db, checkEscalation, handleEscalation, handleCallOutcome);
  } catch (error) {
    console.error(`[Webhook:${providerType}] error:`, error);
    res.status(500).send('Internal Error');
  }
});


import { createClient } from '@supabase/supabase-js';




// Dispatcher stage log ring buffer (SuperAdmin only)
router.get('/debug/dispatcher-status', requireSuperAdmin, (req, res) => {
  res.status(200).json({ logs: dispatcherLogs });
});

// Force sync queue state to recover stranded leads (SuperAdmin only)
router.post('/debug/sync-queue-state', requireSuperAdmin, async (req, res) => {
  try {
    if (!db.supabase) {
      return res.status(503).json({ success: false, error: 'Supabase not configured' });
    }

    // 1. Find lead IDs currently marked queued/re-queued in the legacy table
    const { data: candidateLeads, error: leadErr } = await db.supabase
      .from('leads')
      .select('id')
      .in('status', ['queued', 're-queued']);
    if (leadErr) throw leadErr;
    const leadIds = (candidateLeads || []).map(l => l.id);
    if (leadIds.length === 0) {
      return res.json({ success: true, repaired_count: 0, note: 'No legacy leads in queued state' });
    }

    // 2. Resolve them to active_lead_ids
    const { data: activeLeads, error: alErr } = await db.supabase
      .from('active_leads')
      .select('active_lead_id')
      .in('lead_id', leadIds);
    if (alErr) throw alErr;
    const activeLeadIds = (activeLeads || []).map(al => al.active_lead_id);
    if (activeLeadIds.length === 0) {
      return res.json({ success: true, repaired_count: 0, note: 'No active_leads mapping found' });
    }

    // 3. Repair call_queue rows stuck at dispatched/failed
    //    Guard: ONLY re-queue if linked lead is still 'queued' or 're-queued' — never touch closed leads
    const { data: repaired, error: cqErr } = await db.supabase
      .from('call_queue')
      .update({ status: 'queued', next_attempt_at: new Date().toISOString() })
      .in('active_lead_id', activeLeadIds)
      .in('status', ['dispatched', 'failed'])
      .select();
    if (cqErr) throw cqErr;

    const repaired_count = (repaired || []).length;
    const auditTenant = req.user?.tenant_id || 'default-tenant';
    try { await db.insertAuditLog(auditTenant, 'queue_state_synced', { repaired_count }); } catch(e) {}

    res.json({ success: true, repaired_count });
  } catch (err) {
    console.error('Failed to sync queue state:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

export default router;

