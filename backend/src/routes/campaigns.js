const _voiceAgentCache = new Map(); // key -> { time, data }
import { EventEmitter } from 'events';
import { Router } from 'express';
import db from '../config/db.js';
import { addCampaignJob, campaignQueue } from '../services/queue/campaignQueue.js';
import { resolveAgentName, validateAgentBelongsToTenant, isTaggedAgent } from '../lib/tenantIdentity.js';

const router = Router();

// Create a global emitter for SSE
if (!global.sseEmitter) {
    global.sseEmitter = new EventEmitter();
}

/**
 * POST /campaigns
 * Creates a new campaign and queues it for background ingestion.
 */
router.post('/', async (req, res, next) => {
    try {
        const { name, leads, scheduled_at, custom_scoring_rules } = req.body;
        const tenant_id = req.tenant_id || req.body?.tenant_id || req.headers['x-tenant-id'];

        if (!tenant_id) {
            return res.status(400).json({ error: 'Validation Error', message: 'tenant_id is required.' });
        }

        if (leads !== undefined && !Array.isArray(leads)) {
            return res.status(400).json({ error: 'Validation Error', message: 'leads must be an array if provided.' });
        }

        if (req.body.voice_agent_id) {
            if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(req.body.voice_agent_id)) {
                return res.status(400).json({ error: 'Invalid voice_agent_id' });
            }
        }

        const campaignLeads = Array.isArray(leads) ? leads : [];
        const initialStatus = req.body.status || (scheduled_at ? 'scheduled' : (campaignLeads.length > 0 ? 'queued' : 'draft'));

        // 1. Create campaign in DB
        const campaign = await db.insertCampaign({
            tenant_id,
            name: name || 'API Generated Campaign',
            total_leads: campaignLeads.length,
            status: initialStatus,
            scheduled_at,
            voice_agent_id: req.body.voice_agent_id || null,
            voice_provider: req.body.voice_provider || null,
            max_concurrency: req.body.concurrency_limit || req.body.max_concurrency || 3,
            configuration: { 
                ...(req.body.configuration || {}),
                custom_scoring_rules: custom_scoring_rules || [] 
            }
        });

        // 2. Add job to BullMQ only if leads are present
        let jobId = null;
        if (campaignLeads.length > 0) {
            const job = await addCampaignJob(campaign.id, tenant_id, campaignLeads, scheduled_at);
            jobId = job?.id;
            if (jobId) {
                await db.updateCampaign(campaign.id, { job_id: jobId });
            }
        }

        // Auto-purge in-progress campaign draft for this tenant on successful launch
        await db.deleteCampaignDraft(tenant_id).catch(() => {});

        res.status(campaignLeads.length > 0 ? 202 : 201).json({
            success: true,
            message: campaignLeads.length > 0 
                ? (scheduled_at ? 'Campaign scheduled successfully' : 'Campaign queued for ingestion')
                : 'Campaign created successfully',
            campaignId: campaign.id,
            campaign,
            ...campaign
        });

    } catch (error) {
        next(error);
    }
});

/**
 * POST /campaigns/dial-existing
 * Creates a campaign from existing unassigned leads in the database.
 */
router.post('/dial-existing', async (req, res, next) => {
    try {
        const { name, lead_ids  } = req.body;
    const tenant_id = req.tenant_id;

        if (!tenant_id || !lead_ids || !Array.isArray(lead_ids)) {
            return res.status(400).json({ error: 'Validation Error', message: 'tenant_id and lead_ids array required.' });
        }

        if (req.body.voice_agent_id) {
            if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(req.body.voice_agent_id)) {
                return res.status(400).json({ error: 'Invalid voice_agent_id' });
            }
        }

        // 1. Create Campaign
        const campaign = await db.insertCampaign({
            tenant_id,
            name: name || 'Batch Campaign',
            total_leads: lead_ids.length,
            status: 'processing',
            voice_agent_id: req.body.voice_agent_id || null,
            voice_provider: req.body.voice_provider || null
        });

        // 2. Assign Leads to Campaign and set status to 'queued'
        await db.assignLeadsToCampaign(tenant_id, campaign.id, lead_ids);

        // Auto-purge in-progress campaign draft for this tenant on launch
        await db.deleteCampaignDraft(tenant_id).catch(() => {});

        // assignLeadsToCampaign already called enqueueToDialer for each lead, inserting
        // call_queue rows that the Postgres-driven dispatcher will pick up on its next poll tick.
        // No manual trigger needed — processQueue() is disabled in favour of the new dispatcher.

        res.status(200).json({
            success: true,
            message: `Successfully enqueued ${lead_ids.length} leads for dialing.`,
            campaignId: campaign.id
        });
    } catch (error) {
        next(error);
    }
});

/**
 * PATCH /campaigns/:name/concurrency
 * Update the max_concurrency for a specific campaign.
 */
router.patch('/:name/concurrency', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id || req.body?.tenant_id || req.headers['x-tenant-id'];
        const { name } = req.params;
        const { max_concurrency } = req.body;
        
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
        
        const concurrency = parseInt(max_concurrency, 10);
        if (isNaN(concurrency) || concurrency < 1 || concurrency > 50) {
            return res.status(400).json({ error: 'max_concurrency must be an integer between 1 and 50' });
        }
        
        const allCampaigns = await db.getCampaigns(tenant_id);
        const campaign = allCampaigns.find(c => c.name.toLowerCase() === name.toLowerCase());
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }
        
        if (db.supabase) {
            const { error } = await db.supabase
                .from('campaigns')
                .update({ max_concurrency: concurrency, updated_at: new Date().toISOString() })
                .eq('id', campaign.id)
                .eq('tenant_id', tenant_id);
            if (error) throw error;
        }
        
        res.json({ success: true, max_concurrency: concurrency });
    } catch (error) {
        next(error);
    }
});

/**
 * PATCH /campaigns/:id
 * Updates campaign properties (status, concurrency, provider, agent_id, etc.)
 */
router.patch('/:id', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id || req.body?.tenant_id || req.headers['x-tenant-id'];
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

        const { id } = req.params;
        const updates = req.body || {};

        const allCampaigns = await db.getCampaigns(tenant_id);
        const campaign = allCampaigns.find(c => c.id === id || c.name.toLowerCase() === id.toLowerCase());
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        const allowedFields = ['name', 'status', 'max_concurrency', 'concurrency_limit', 'voice_agent_id', 'voice_provider', 'whatsapp_threshold'];
        const updatePayload = {};
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                if (field === 'concurrency_limit') {
                    updatePayload.max_concurrency = parseInt(updates[field], 10);
                } else if (field === 'max_concurrency') {
                    updatePayload.max_concurrency = parseInt(updates[field], 10);
                } else {
                    updatePayload[field] = updates[field];
                }
            }
        }

        const updatedCampaign = await db.updateCampaign(campaign.id, updatePayload);

        // If pausing, pause queued rows in call_queue
        if (updates.status === 'paused' && db.supabase) {
            await db.supabase
                .from('call_queue')
                .update({ status: 'paused' })
                .eq('tenant_id', tenant_id)
                .eq('campaign_id', campaign.id)
                .in('status', ['queued']);
        } else if (updates.status === 'active' && db.supabase) {
            await db.supabase
                .from('call_queue')
                .update({ status: 'queued', next_attempt_at: new Date().toISOString() })
                .eq('tenant_id', tenant_id)
                .eq('campaign_id', campaign.id)
                .eq('status', 'paused');

            // Trigger dispatcher tick
            import('../workers/dispatcher.js').then(d => {
                if (d.default && typeof d.default.tick === 'function') {
                    d.default.tick().catch(() => {});
                }
            }).catch(() => {});
        }

        res.json({ success: true, campaign: updatedCampaign });
    } catch (error) {
        next(error);
    }
});

/**
 * POST /campaigns/:id/dial
 * Triggers batch dialing for a campaign by ID or Name.
 */
router.post('/:id/dial', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id || req.body?.tenant_id || req.headers['x-tenant-id'];
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

        const { id } = req.params;
        const { whatsapp_threshold, max_concurrency } = req.body || {};
        const thresholdVal = whatsapp_threshold !== undefined ? parseInt(whatsapp_threshold, 10) : 70;
        const concurrencyVal = max_concurrency !== undefined ? parseInt(max_concurrency, 10) : 3;

        const { dialAllCampaignLeads } = await import('../services/campaignDialer.js');
        const result = await dialAllCampaignLeads(tenant_id, id, thresholdVal, concurrencyVal);
        res.json(result);
    } catch (error) {
        next(error);
    }
});

/**
 * POST /campaigns/:id/pause
 * Pauses a campaign and pauses all queued calls in call_queue.
 */
router.post('/:id/pause', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id || req.body?.tenant_id || req.headers['x-tenant-id'];
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

        const { id } = req.params;
        const allCampaigns = await db.getCampaigns(tenant_id);
        const campaign = allCampaigns.find(c => c.id === id || c.name.toLowerCase() === id.toLowerCase());
        if (!campaign) {
            return res.status(404).json({ error: 'Campaign not found' });
        }

        await db.updateCampaign(campaign.id, { status: 'paused' });
        if (db.supabase) {
            await db.supabase
                .from('call_queue')
                .update({ status: 'paused' })
                .eq('tenant_id', tenant_id)
                .eq('campaign_id', campaign.id)
                .in('status', ['queued']);
        }

        res.json({ success: true, message: `Campaign ${campaign.name} paused successfully.` });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /campaigns
 * List all campaigns for a tenant
 */
router.get('/', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
        
        const campaigns = await db.getCampaigns(tenant_id);
        res.json({ success: true, campaigns });
    } catch (error) {
        next(error);
    }
});

/**
 * GET /campaigns/draft and GET /campaigns/draft/:tenant_id
 * Retrieve the active incomplete campaign draft for a tenant
 */
const handleGetDraft = async (req, res, next) => {
    try {
        const tenant_id = req.params.tenant_id || req.tenant_id || req.query.tenant_id;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
        
        const draft = await db.getCampaignDraft(tenant_id);
        res.json({ success: true, draft: draft || null });
    } catch (error) {
        next(error);
    }
};
router.get('/draft', handleGetDraft);
router.get('/draft/:tenant_id', handleGetDraft);

/**
 * POST /campaigns/draft and POST /campaigns/draft/:tenant_id
 * Save or update an in-progress campaign draft
 */
const handlePostDraft = async (req, res, next) => {
    try {
        const tenant_id = req.params.tenant_id || req.tenant_id || req.body.tenant_id || req.query.tenant_id;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

        const draftPayload = req.body.draft || req.body;
        const draft = await db.upsertCampaignDraft(tenant_id, draftPayload);
        res.status(200).json({ success: true, draft });
    } catch (error) {
        next(error);
    }
};
router.post('/draft', handlePostDraft);
router.post('/draft/:tenant_id', handlePostDraft);

/**
 * DELETE /campaigns/draft and DELETE /campaigns/draft/:tenant_id
 * Discard / delete the campaign draft for a tenant
 */
const handleDeleteDraft = async (req, res, next) => {
    try {
        const tenant_id = req.params.tenant_id || req.tenant_id || req.query.tenant_id || req.body?.tenant_id;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

        const result = await db.deleteCampaignDraft(tenant_id);
        res.json({ success: true, message: 'Campaign draft discarded successfully', ...result });
    } catch (error) {
        next(error);
    }
};
router.delete('/draft', handleDeleteDraft);
router.delete('/draft/:tenant_id', handleDeleteDraft);

/**
 * GET /campaigns/:id/progress
 * SSE endpoint for real-time campaign progress tracking
 */
router.get('/:id/progress', (req, res) => {
    const { id } = req.params;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Send initial connection established message
    res.write(`data: ${JSON.stringify({ event: 'connected', campaignId: id })}\n\n`);

    const progressListener = (data) => {
        if (data.jobId === id) {
            res.write(`data: ${JSON.stringify({ event: 'progress', progress: data.progress })}\n\n`);
        }
    };

    const completedListener = (data) => {
        if (data.jobId === id) {
            res.write(`data: ${JSON.stringify({ event: 'completed', result: data.result })}\n\n`);
            // Optional: res.end();
        }
    };

    const failedListener = (data) => {
        if (data.jobId === id) {
            res.write(`data: ${JSON.stringify({ event: 'failed', error: data.error })}\n\n`);
        }
    };

    global.sseEmitter.on('campaign-progress', progressListener);
    global.sseEmitter.on('campaign-completed', completedListener);
    global.sseEmitter.on('campaign-failed', failedListener);

    // Clean up when client closes connection
    req.on('close', () => {
        global.sseEmitter.removeListener('campaign-progress', progressListener);
        global.sseEmitter.removeListener('campaign-completed', completedListener);
        global.sseEmitter.removeListener('campaign-failed', failedListener);
    });
});

/**
 * GET /campaigns/analytics
 * SSE endpoint for global real-time analytics
 */
router.get('/analytics/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    res.write(`data: ${JSON.stringify({ event: 'connected' })}\n\n`);

    let lastProcessed = null;
    let lastTime = null;

    const interval = setInterval(async () => {
        try {
            const counts = await campaignQueue.getJobCounts();
            const totalProcessed = await db.getTotalProcessedLeads();
            
            let throughput = 0;
            const now = Date.now();
            
            if (lastProcessed !== null && lastTime !== null) {
                const timeDiff = (now - lastTime) / 1000;
                if (timeDiff > 0) {
                    const processedDiff = Math.max(0, totalProcessed - lastProcessed);
                    throughput = Math.floor((processedDiff / timeDiff) * 60);
                }
            }
            
            lastProcessed = totalProcessed;
            lastTime = now;
            
            res.write(`data: ${JSON.stringify({ 
                event: 'analytics', 
                metrics: {
                    queueHealth: counts,
                    throughputPerMinute: throughput
                }
            })}\n\n`);
        } catch (error) {
            console.error('Analytics stream error:', error);
        }
    }, 3000);

    req.on('close', () => {
        clearInterval(interval);
    });
});

/**
 * GET /campaigns/configured-providers
 * Returns which voice providers have credentials configured for the tenant
 */
router.get('/configured-providers', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
        
        // A provider counts as configured if its global .env key is set, or the tenant saved credentials
        const providers = {
            gnani: !!process.env.GNANI_API_KEY,
            mock: process.env.NODE_ENV !== 'production'
        };
        
        const db = (await import('../config/db.js')).default;
        if (db.supabase) {
            const { data } = await db.supabase
                .from('tenant_voice_providers')
                .select('provider_type')
                .is('disabled_at', null)
                .eq('tenant_id', tenant_id);
                
            if (data) {
                for (const row of data) {
                    providers[row.provider_type] = true;
                }
            }
        } else {
            // Mock DB logic
            const configured = (db.mockDb?.tenantVoiceProviders || []).filter(p => p.tenant_id === tenant_id);
            for (const row of configured) {
                providers[row.provider_type] = true;
            }
        }
        
        res.json({ success: true, providers });
    } catch (error) {
        next(error);
    }
});

router.get('/voice-agents', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });
        
        const providerQuery = req.query.provider;
        const isAggregated = !providerQuery || providerQuery === 'all';
        
        const voiceProviderFactory = (await import('../services/voiceProvider/index.js'));
        
        if (!isAggregated) {
            let provider;
            try {
                provider = await voiceProviderFactory.getProvider(tenant_id, providerQuery);
            } catch (err) {
                console.error(`[VOICE_AGENT_ERROR] Failed to init provider ${providerQuery}:`, err);
                return res.status(502).json({ success: false, error: "voice_provider_unavailable", details: 500 });
            }

            let agents = null;
            try {
                agents = await provider.getAgents();
            } catch (fetchError) {
                console.error(`[VOICE_AGENT_ERROR] Fetch error:`, fetchError);
                return res.status(502).json({ success: false, error: "voice_provider_unavailable", details: 502 });
            }

            return res.json({ success: true, agents: agents || [] });
        } else {
            const providersToFetch = [];
            if (process.env.GNANI_API_KEY || process.env.GNANI_AGENT_ID) providersToFetch.push('gnani');

            if (db.supabase) {
                const { data } = await db.supabase
                    .from('tenant_voice_providers')
                    .select('provider_type')
                    .is('disabled_at', null)
                    .eq('tenant_id', tenant_id);
                if (data) {
                    for (const row of data) {
                        if (!providersToFetch.includes(row.provider_type)) {
                            providersToFetch.push(row.provider_type);
                        }
                    }
                }
            } else {
                const configured = (db.mockDb?.tenantVoiceProviders || []).filter(p => p.tenant_id === tenant_id);
                for (const row of configured) {
                    if (!providersToFetch.includes(row.provider_type)) {
                        providersToFetch.push(row.provider_type);
                    }
                }
            }
            
            const cacheKey = `${tenant_id}:${providerQuery || 'all'}`;
            const cached = _voiceAgentCache.get(cacheKey);
            const now = Date.now();
            if (cached && (now - cached.time < 60000) && !req.query.refresh) {
                return res.json({ success: true, agents: cached.data });
            }

            const fetchProviderAgents = async (pName) => {
                try {
                    const provider = await voiceProviderFactory.getProvider(tenant_id, pName);
                    const timeoutMs = 3500;
                    const timeoutPromise = new Promise((_, reject) => {
                        const timer = setTimeout(() => reject(new Error(`Timeout fetching ${pName}`)), timeoutMs);
                        if (typeof timer.unref === 'function') timer.unref();
                    });
                    let agents = await Promise.race([provider.getAgents(), timeoutPromise]);
                    return (agents || []).map(a => ({ ...a, provider: pName }));
                } catch (err) {
                    console.warn(`[VOICE_AGENT_WARN] Fast fallback for ${pName}:`, err.message);
                    return [];
                }
            };

            const settled = await Promise.allSettled(providersToFetch.map(fetchProviderAgents));
            let allAgents = [];
            for (const r of settled) {
                if (r.status === 'fulfilled' && Array.isArray(r.value)) {
                    allAgents = allAgents.concat(r.value);
                }
            }

            _voiceAgentCache.set(cacheKey, { time: now, data: allAgents });
            return res.json({ success: true, agents: allAgents });
        }
    } catch (error) {
        next(error);
    }
});




/**
 * DELETE /campaigns/:id
 * Delete or soft-delete a campaign by ID
 */
router.delete('/:id', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id || req.query.tenant_id || req.body?.tenant_id;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

        const campaignId = req.params.id;
        const softDelete = req.body?.soft_delete === true || req.query.soft_delete === 'true';

        const result = await db.deleteCampaign(tenant_id, campaignId, { softDelete });
        await db.insertAuditLog(tenant_id, 'campaign_deleted', { campaignId, ...result });

        res.json({
            success: true,
            message: `Campaign "${result.campaignName || campaignId}" successfully deleted.`,
            ...result
        });
    } catch (error) {
        next(error);
    }
});

/**
 * DELETE /campaigns
 * Delete or soft-delete a campaign by name or id in request body
 */
router.delete('/', async (req, res, next) => {
    try {
        const tenant_id = req.tenant_id || req.query.tenant_id || req.body?.tenant_id;
        if (!tenant_id) return res.status(400).json({ error: 'tenant_id is required' });

        const { campaign_name, campaign_id, id, soft_delete } = req.body || {};
        const identifier = campaign_id || id || campaign_name || req.query.campaign_id || req.query.campaign_name;
        if (!identifier) {
            return res.status(400).json({ error: 'campaign_name or campaign_id is required' });
        }

        const softDelete = soft_delete === true || req.query.soft_delete === 'true';
        const result = await db.deleteCampaign(tenant_id, identifier, { softDelete });
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

export default router;


