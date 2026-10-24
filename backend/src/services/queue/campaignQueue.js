import { Queue, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import dotenv from 'dotenv';
import EventEmitter from 'events';

dotenv.config();

const isTest = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test') || arg.includes('--test'));

class MockQueue extends EventEmitter {
    constructor() {
        super();
        this._repeatableJobs = [];
        this._jobs = [];
    }
    async add(name, data, opts = {}) {
        const job = { id: opts.jobId || `job-${Date.now()}`, name, data, opts };
        this._jobs.push(job);
        if (opts.repeat) {
            this._repeatableJobs.push({
                key: opts.repeat.key || `repeat-${opts.repeat.pattern}-${opts.jobId}`,
                name,
                id: opts.jobId,
                cron: opts.repeat.pattern,
                next: Date.now() + 60000
            });
        }
        return job;
    }
    async getRepeatableJobs() {
        return [...this._repeatableJobs];
    }
    async removeRepeatableByKey(key) {
        const idx = this._repeatableJobs.findIndex(j => j.key === key);
        if (idx !== -1) {
            this._repeatableJobs.splice(idx, 1);
            return true;
        }
        return false;
    }
    async getJobCounts() {
        return { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 };
    }
    async close() {}
}

let connection = null;
let queueInstance = null;
let queueEventsInstance = null;

if (isTest) {
    queueInstance = new MockQueue();
    queueEventsInstance = new EventEmitter();
} else {
    connection = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
        maxRetriesPerRequest: null,
        // Exponential backoff capped at 30s to avoid hammering a missing Redis instance
        retryStrategy: (times) => Math.min(Math.pow(2, times) * 200, 30000),
        reconnectOnError: () => false,
        enableOfflineQueue: true
    });
    connection.on('error', () => {
        // Gracefully suppress connection errors when running offline/in tests
    });
    queueInstance = new Queue('campaign-ingestion', { connection });
    queueEventsInstance = new QueueEvents('campaign-ingestion', { connection });
    queueInstance.on('error', () => {});
    queueEventsInstance.on('error', () => {});
}

export const campaignQueue = queueInstance;
export const campaignQueueEvents = queueEventsInstance;
export const closeCampaignQueue = async () => {
    if (queueInstance && typeof queueInstance.close === 'function') {
        await queueInstance.close();
    }
    if (queueEventsInstance && typeof queueEventsInstance.close === 'function') {
        await queueEventsInstance.close();
    }
    if (connection) {
        await connection.quit().catch(() => connection.disconnect());
    }
};

export const addCampaignJob = async (campaignId, tenantId, fileData, scheduleTime = null) => {
    const jobOptions = {
        jobId: campaignId, // prevent duplicate jobs for the same campaign
        removeOnComplete: true,
        removeOnFail: false,
    };
    
    if (scheduleTime) {
        const delay = new Date(scheduleTime).getTime() - Date.now();
        if (delay > 0) {
            jobOptions.delay = delay;
        }
    }

    const job = await campaignQueue.add('ingest-leads', { campaignId, tenantId, fileData }, jobOptions);
    return job;
};

// Scheduler Methods
export const addRepeatableCampaignJob = async (cronExpression, tenantId, type, metaData) => {
    // Generate a unique ID for the job based on type and tenant
    const jobId = `recurring-${type}-${tenantId}-${Date.now()}`;
    
    const jobOptions = {
        repeat: { pattern: cronExpression },
        jobId: jobId, // BullMQ uses this internally for repeatable jobs alongside the pattern
    };

    // The name of the job can be 'ingest-leads' or 'crm-sync'
    const jobName = type === 'crm_sync' ? 'crm-sync' : 'ingest-leads';
    
    // We add it to the queue. Note: fileData might be empty for crm-sync or auto-generated
    const job = await campaignQueue.add(jobName, { campaignId: jobId, tenantId, metaData, isRecurring: true }, jobOptions);
    return job;
};

export const getRepeatableJobs = async () => {
    return await campaignQueue.getRepeatableJobs();
};

export const removeRepeatableJob = async (key) => {
    return await campaignQueue.removeRepeatableByKey(key);
};

// Listen to global events for SSE
campaignQueueEvents.on('progress', ({ jobId, data }, timestamp) => {
    // You can emit this via Node's EventEmitter to be picked up by the SSE endpoint
    // Or handle it directly if the queue is on the same server
    if (global.sseEmitter) {
        global.sseEmitter.emit('campaign-progress', { jobId, progress: data });
    }
});

campaignQueueEvents.on('completed', ({ jobId, returnvalue }) => {
    if (global.sseEmitter) {
        global.sseEmitter.emit('campaign-completed', { jobId, result: returnvalue });
    }
});

campaignQueueEvents.on('failed', ({ jobId, failedReason }) => {
    if (global.sseEmitter) {
        global.sseEmitter.emit('campaign-failed', { jobId, error: failedReason });
    }
});
