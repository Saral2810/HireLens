import express from 'express';
import schedulerService from '../services/schedulerService.js';
import { addRepeatableCampaignJob, getRepeatableJobs, removeRepeatableJob } from '../services/queue/campaignQueue.js';

const router = express.Router();

/**
 * @route POST /scheduler
 * @desc Create a new scheduled task (campaign dial, ingestion, or CRM sync)
 */
router.post('/', async (req, res) => {
    try {
        const tenantId = req.tenant_id || req.body.tenantId || req.body.tenant_id;
        const {
            type,
            name,
            target_campaign,
            campaign_name,
            scheduled_at,
            schedule_time,
            cron_expression,
            cronExpression,
            max_concurrency,
            whatsapp_threshold,
            metaData,
            payload
        } = req.body;

        const effectiveType = type || 'campaign_dial';
        const effectiveCampaign = target_campaign || campaign_name || (metaData?.campaign_name) || null;
        const effectiveScheduledAt = scheduled_at || schedule_time || null;
        const effectiveCron = cron_expression || cronExpression || null;

        if (!tenantId) {
            return res.status(400).json({ error: 'tenant_id is required' });
        }

        if (!effectiveScheduledAt && !effectiveCron) {
            return res.status(400).json({ error: 'Either scheduled_at (one-time date) or cron_expression (recurring) is required.' });
        }

        if (effectiveType === 'campaign_dial' && !effectiveCampaign) {
            return res.status(400).json({ error: 'target_campaign is required for campaign_dial jobs.' });
        }

        // Create job using unified schedulerService
        const job = await schedulerService.createScheduledJob({
            tenantId,
            type: effectiveType,
            name,
            targetCampaign: effectiveCampaign,
            scheduledAt: effectiveScheduledAt,
            cronExpression: effectiveCron,
            payload: {
                ...(metaData || {}),
                ...(payload || {}),
                whatsapp_threshold,
                max_concurrency
            }
        });

        // Also add to BullMQ if recurring and not in test/offline
        if (effectiveCron && (effectiveType === 'crm_sync' || effectiveType === 'ingestion')) {
            try {
                await addRepeatableCampaignJob(effectiveCron, tenantId, effectiveType, metaData || {});
            } catch(e) {
                // BullMQ optional sync error ignored
            }
        }

        res.status(201).json({
            success: true,
            message: 'Scheduled task created successfully',
            jobId: job.id,
            job
        });
    } catch (error) {
        console.error('[POST /scheduler] Error adding scheduled job:', error);
        res.status(500).json({ error: error.message || 'Internal server error' });
    }
});

/**
 * @route GET /scheduler
 * @desc Get all active scheduled jobs for the tenant
 */
router.get('/', async (req, res) => {
    try {
        const tenantId = req.tenant_id || req.query.tenant_id;
        const serviceJobs = await schedulerService.getScheduledJobs(tenantId);
        
        let bullmqJobs = [];
        try {
            bullmqJobs = await getRepeatableJobs();
        } catch (e) {
            bullmqJobs = [];
        }

        // Map BullMQ jobs to uniform format if not already in serviceJobs
        const existingJobKeys = new Set(serviceJobs.map(j => j.id));
        const formattedBullmq = (bullmqJobs || [])
            .filter(bj => !existingJobKeys.has(bj.id) && !existingJobKeys.has(bj.key))
            .map(bj => ({
                id: bj.key || bj.id,
                name: bj.name || bj.id,
                type: bj.name?.includes('crm') ? 'crm_sync' : 'ingestion',
                target_campaign: null,
                cron: bj.cron,
                cron_expression: bj.cron,
                next: bj.next,
                next_run: bj.next ? new Date(bj.next).toISOString() : null,
                status: 'scheduled',
                key: bj.key,
                is_bullmq: true
            }));

        const allJobs = [...serviceJobs, ...formattedBullmq];

        res.status(200).json({ success: true, jobs: allJobs });
    } catch (error) {
        console.error('[GET /scheduler] Error fetching scheduled jobs:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/**
 * @route POST /scheduler/:id/trigger
 * @desc Manually run a scheduled job immediately
 */
router.post('/:id/trigger', async (req, res) => {
    try {
        const tenantId = req.tenant_id || req.query.tenant_id || req.body.tenant_id;
        const { id } = req.params;
        const decodedId = decodeURIComponent(id);

        const result = await schedulerService.triggerJobNow(decodedId, tenantId);
        res.status(200).json({ success: true, message: 'Job triggered successfully', result });
    } catch (error) {
        console.error(`[POST /scheduler/${req.params.id}/trigger] Error:`, error);
        res.status(500).json({ error: error.message || 'Failed to trigger scheduled job' });
    }
});

/**
 * @route DELETE /scheduler/:key
 * @desc Remove a scheduled job
 */
router.delete('/:key', async (req, res) => {
    try {
        const tenantId = req.tenant_id || req.query.tenant_id;
        const { key } = req.params;
        const decodedKey = decodeURIComponent(key);

        const removedFromService = await schedulerService.cancelScheduledJob(decodedKey, tenantId);
        
        try {
            await removeRepeatableJob(decodedKey);
        } catch (e) {}

        res.status(200).json({ success: true, message: 'Scheduled job removed' });
    } catch (error) {
        console.error('[DELETE /scheduler/:key] Error removing scheduled job:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

export default router;
