import { Router } from 'express';
import db from '../config/db.js';
import { authenticateApiKey } from '../middleware/auth.js';
import { validateLead, cleanPhone } from '../utils/validation.js';
import { computeLeadScore } from '../services/scoringEngine.js';
import { enqueueLead } from '../services/queueService.js';
import voiceProviderFactory from '../services/voiceProvider/index.js';
import { getDashboardAnalytics } from '../services/dashboardService.js';

const router = Router();

// Secure all endpoints in this router with API Key
router.use(authenticateApiKey);

/**
 * GET /api/v1/health
 * Validates the API key and returns tenant info.
 */
router.get('/health', (req, res) => {
  res.json({
    success: true,
    message: 'API Key is valid',
    tenant_id: req.tenant_id
  });
});

/**
 * GET /api/v1/telephony/health
 * Basic voice-provider health: which provider is the default and whether it has credentials.
 */
router.get('/telephony/health', (req, res) => {
  const provider = process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
  res.json({
    success: true,
    timestamp: new Date().toISOString(),
    tenant_id: req.tenant_id,
    default_provider: provider,
    provider_configured: provider === 'gnani' ? !!process.env.GNANI_API_KEY : true,
    dialer_enabled: process.env.DIALER_ENABLED !== 'false'
  });
});

/**
 * GET /api/v1/leads
 * Lists leads for the authenticated tenant.
 */
router.get('/leads', async (req, res, next) => {
  try {
    const leads = await db.getLeads(req.tenant_id);
    res.json({ success: true, count: leads.length, leads });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/leads
 * Ingests a new lead.
 */
router.post('/leads', async (req, res, next) => {
  try {
    const leadData = req.body;

    const valResult = validateLead(leadData);
    if (!valResult.isValid) {
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Invalid lead payload',
        errors: valResult.errors
      });
    }

    const cleanedPhone = cleanPhone(leadData.phone);

    // Check for duplicate
    const existingLead = await db.findLeadByPhone(req.tenant_id, cleanedPhone);
    if (existingLead) {
      return res.status(409).json({
        success: false,
        error: 'Conflict',
        message: 'Lead with this phone number already exists.',
        lead: existingLead
      });
    }

    const weights = await db.getWeights(req.tenant_id);

    const processedLead = {
      ...leadData,
      tenant_id: req.tenant_id,
      phone: cleanedPhone,
      dataset_id: leadData.dataset_id || 'api-ingestion',
      campaign_name: leadData.campaign_name || 'API Campaigns',
      raw_data: leadData.raw_data || {}
    };

    if (!processedLead.raw_data.platform_lead_id) {
      processedLead.raw_data.platform_lead_id = 'lead_' + Math.random().toString(36).substr(2, 9);
    }
    if (!processedLead.raw_data.campaign_id) {
      processedLead.raw_data.campaign_id = 'cmp_' + Math.random().toString(36).substr(2, 9);
    }

    const score = await computeLeadScore(processedLead, weights);
    processedLead.score = score;

    const savedLead = await db.insertLead(processedLead);
    await enqueueLead(savedLead.id, score);

    await db.insertAuditLog(req.tenant_id, 'lead_ingested_via_api', {
      lead_id: savedLead.id,
      phone: cleanedPhone,
      score,
    });

    res.status(201).json({
      success: true,
      message: 'Lead created successfully',
      lead: savedLead
    });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/v1/leads/:id/call
 * Triggers a call to a specific lead.
 */
router.post('/leads/:id/call', async (req, res, next) => {
  try {
    const { id } = req.params;
    
    const lead = await db.findLeadById(id);
    if (!lead) {
      return res.status(404).json({ error: 'Not Found', message: 'Lead not found.' });
    }

    // Ensure the lead belongs to the authenticated tenant
    if (lead.tenant_id !== req.tenant_id) {
      return res.status(403).json({ error: 'Forbidden', message: 'Access denied to this lead.' });
    }

    const onboarding = await db.getOnboardingConfig(req.tenant_id);
    
    // Dynamic URL mapping
    const protocol = req.protocol;
    const host = req.get('host');
    const apiCampaigns = await db.getCampaigns(req.tenant_id);
    const apiCampaign = apiCampaigns.find(c => c.name === lead.campaign_name);
    const providerType = apiCampaign?.voice_provider || onboarding?.aiAgent?.voiceProvider || process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
    const baseUrl = (process.env.PUBLIC_APP_URL || `${protocol}://${host}`).replace(/\/+$/, '');
    const webhookUrl = `${baseUrl}/leads/webhook/${providerType}?tenant_id=${encodeURIComponent(lead.tenant_id)}`;

    // Initialize session
    const provider = await voiceProviderFactory.getProvider(lead.tenant_id, providerType);
    const result = await provider.initSession(lead, { ...onboarding, voice_agent_id: apiCampaign?.voice_agent_id || null, campaign: apiCampaign }, webhookUrl);

    const session = await db.insertCallSession({
      tenant_id: req.tenant_id,
      lead_id: id,
      provider_session_id: result.provider_session_id,
      disposition: 'calling'
    });

    await db.insertAuditLog(req.tenant_id, 'api_call_initiated', {
      lead_id: id,
      provider_session_id: result.provider_session_id
    });

    res.json({ 
      success: true, 
      message: 'Call initiated successfully.', 
      provider_session_id: result.provider_session_id, 
      session_id: session.id 
    });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/campaigns
 * Lists campaigns for the authenticated tenant.
 */
router.get('/campaigns', async (req, res, next) => {
  try {
    const campaigns = await db.getCampaigns(req.tenant_id);
    res.json({ success: true, count: campaigns.length, campaigns });
  } catch (error) {
    next(error);
  }
});

/**
 * GET /api/v1/webhooks
 * List webhooks
 */
router.get('/webhooks', (req, res) => {
  // Mock endpoint for demo
  res.json({
    success: true,
    webhooks: [
      { id: 'wh_1', url: 'https://hooks.zapier.com/hooks/catch/123/abc', events: ['lead.scored', 'call.completed'], created_at: new Date().toISOString() }
    ]
  });
});

/**
 * POST /api/v1/webhooks
 * Create webhook
 */
router.post('/webhooks', (req, res) => {
  const { url, events } = req.body;
  if (!url) return res.status(400).json({ success: false, message: 'URL is required' });
  res.json({
    success: true,
    webhook: {
      id: 'wh_' + Math.random().toString(36).substr(2, 9),
      url,
      events: events || ['*'],
      created_at: new Date().toISOString()
    }
  });
});

/**
 * GET /api/v1/analytics/dashboard
 * Live dashboard metrics rollup
 */
router.get('/analytics/dashboard', async (req, res, next) => {
  try {
    const data = await getDashboardAnalytics(req.tenant_id);
    res.json({ success: true, ...data });
  } catch (error) {
    next(error);
  }
});

export default router;
