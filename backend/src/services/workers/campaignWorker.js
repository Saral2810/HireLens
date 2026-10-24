import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import db from '../../config/db.js';
import dotenv from 'dotenv';
import { sendSlackNotification } from '../slackService.js';
import { normalizeCandidateFields } from '../../utils/validation.js';

const isTest = process.env.NODE_ENV === 'test';
const connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: null,
    // Exponential backoff capped at 30s to avoid hammering a missing Redis instance
    retryStrategy: (times) => isTest ? null : Math.min(Math.pow(2, times) * 200, 30000),
    reconnectOnError: () => false,
    enableOfflineQueue: !isTest
});
connection.on('error', () => {
  // Gracefully suppress connection errors when running offline/in tests
});

const CHUNK_SIZE = 1000;

export const campaignWorker = new Worker('campaign-ingestion', async job => {
    // Check if this is a CRM Sync job
    if (job.name === 'crm-sync') {
        const { tenantId, metaData } = job.data;
        console.log(`Starting recurring CRM Sync for tenant ${tenantId}`);
        // Simulate CRM Sync delay
        await new Promise(resolve => setTimeout(resolve, 2000));
        await sendSlackNotification(`[Scheduler] 🕒 Scheduled CRM Sync completed successfully for tenant "${tenantId}".`);
        return { success: true, processed: 0, type: 'crm-sync' };
    }

    const { campaignId, tenantId, fileData, isRecurring, batchId } = job.data;

    const dataToProcess = fileData || [];
    if (isRecurring && dataToProcess.length === 0) {
        // If it's recurring and has no static file data, we could simulate fetching from CRM
        dataToProcess.push({ name: 'Scheduled Lead', phone: '+1555' + Math.floor(1000000 + Math.random() * 9000000), source: 'Scheduled Auto-Sync' });
    }

    console.log(`Starting ingestion for campaign ${campaignId} with ${dataToProcess.length} leads.`);
    
    // Update campaign status to processing (only if it's a real campaign, not a recurring job ID)
    if (!isRecurring) {
        await db.updateCampaign(campaignId, { 
            status: 'processing', 
            started_at: new Date().toISOString(),
            total_leads: dataToProcess.length
        });
    }

    let processedCount = 0;
    let failedCount = 0;

    for (let i = 0; i < dataToProcess.length; i += CHUNK_SIZE) {
        const chunk = dataToProcess.slice(i, i + CHUNK_SIZE);
        const validLeadsInChunk = [];
        const phonesInChunk = [];

        for (const rawLead of chunk) {
            const rawPhone = rawLead.phone || rawLead.phoneNumber || rawLead.phone_number;
            if (!rawPhone) {
                failedCount++;
                await db.insertLeadIngestionError({
                    campaign_id: campaignId,
                    tenant_id: tenantId,
                    raw_data: rawLead,
                    error_reason: 'Phone number is required'
                });
                continue;
            }

            const rawName = rawLead.name || rawLead.first_name || rawLead.applicant_name || rawLead.customer_name;
            const formattedName = (rawName && String(rawName).trim())
                ? String(rawName).trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
                : 'Customer';

            const newLead = {
                tenant_id: tenantId,
                name: formattedName,
                phone: String(rawPhone).trim(),
                email: rawLead.email || null,
                source: rawLead.source || 'Campaign Upload',
                raw_data: rawLead,
                campaign_name: campaignId,
            };

            const candidateErrors = normalizeCandidateFields(newLead);
            if (candidateErrors.length > 0) {
                failedCount++;
                await db.insertLeadIngestionError({
                    campaign_id: campaignId,
                    tenant_id: tenantId,
                    raw_data: rawLead,
                    error_reason: candidateErrors.join('; ')
                });
                continue;
            }

            validLeadsInChunk.push(newLead);
            phonesInChunk.push(newLead.phone);
        }

        if (validLeadsInChunk.length > 0) {
            // Bulk DNC lookup
            let dncSet = new Set();
            try {
                dncSet = await db.getDncNumbersBatch(tenantId, phonesInChunk);
            } catch (dncErr) {
                console.error(`[CampaignWorker] DNC bulk check error:`, dncErr);
            }

            // Bulk existing lead lookup
            let existingMap = new Map();
            try {
                const existingList = await db.findLeadsByPhones(tenantId, phonesInChunk);
                existingMap = new Map((existingList || []).map(l => [l.phone, l]));
            } catch (err) {
                // Continue with fallback
            }

            const newToInsert = [];
            const existingToLink = [];

            validLeadsInChunk.forEach(l => {
                const existing = existingMap.get(l.phone);
                if (existing) {
                    existingToLink.push(existing.id);
                } else {
                    if (dncSet.has(l.phone)) {
                        l.status = 'dnc';
                    }
                    newToInsert.push(l);
                }
            });

            try {
                let insertedIds = [];
                if (newToInsert.length > 0) {
                    const inserted = await db.insertLeads(newToInsert);
                    insertedIds = (inserted || []).map(l => l.id).filter(Boolean);
                }
                const allCampaignLeadIds = [...insertedIds, ...existingToLink];
                if (campaignId && allCampaignLeadIds.length > 0) {
                    await db.addLeadsToCampaign(tenantId, allCampaignLeadIds, campaignId);
                }
                processedCount += validLeadsInChunk.length;
            } catch (insErr) {
                console.error(`Failed to bulk insert leads for campaign ${campaignId}:`, insErr);
                failedCount += validLeadsInChunk.length;
            }
        }

        // Calculate progress percentage
        const progress = Math.round(((processedCount + failedCount) / dataToProcess.length) * 100);
        await job.updateProgress(progress);
        
        // Update campaign intermediate stats
        if (!isRecurring) {
            await db.updateCampaign(campaignId, {
                processed_leads: processedCount,
                failed_leads: failedCount
            });
        }
    }

    // Final update: set to 'draft' so the campaign requires explicit operator activation before dialing.
    // Leads are fully ingested but NO calls go out until the campaign is explicitly started.
    if (!isRecurring) {
        const tag = batchId || `batch_${tenantId}_${campaignId}_${new Date().toISOString().slice(0, 10)}`;
        await db.updateCampaign(campaignId, { 
            status: 'draft',
            finished_at: new Date().toISOString(),
            processed_leads: processedCount,
            batch_id: tag
        });
        console.log(`[CampaignWorker] Campaign ${campaignId} ingestion complete — status set to DRAFT. Batch: ${tag}. Awaiting explicit activation.`);
    } else {
        await sendSlackNotification(`[Scheduler] 🕒 Scheduled Lead Ingestion completed. Ingested ${processedCount} leads.`);
    }

    console.log(`Completed campaign ${campaignId}. Processed: ${processedCount}, Failed: ${failedCount}`);
    
    return {
        success: true,
        processedCount,
        failedCount,
        campaignId
    };
}, {
    connection,
    concurrency: 5 // Process up to 5 campaigns concurrently per worker instance
});

campaignWorker.on('completed', job => {
    console.log(`Job ${job.id} has completed!`);
});

campaignWorker.on('failed', (job, err) => {
    console.error(`Job ${job.id} has failed with ${err.message}`);
    // Update campaign status to failed if the entire job crashes
    if (job && job.data && job.data.campaignId && !job.data.isRecurring) {
        db.updateCampaign(job.data.campaignId, {
            status: 'failed',
            finished_at: new Date().toISOString()
        }).catch(console.error);
    }
});

// Suppress BullMQ worker-level connection errors (e.g. when Redis is not available in dev/test)
campaignWorker.on('error', () => {});
