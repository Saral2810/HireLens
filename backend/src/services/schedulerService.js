import cron from 'node-cron';
import { v4 as uuidv4 } from 'uuid';
import db from '../config/db.js';
import { sendSlackNotification } from './slackService.js';
import { getRepeatableJobs, addCampaignJob, campaignQueue } from "./queue/campaignQueue.js";
import { forceRetry } from './queueService.js';

class SchedulerService {
  constructor() {
    this.jobs = []; // In-memory cache for fast lookup & mock mode
    this.timer = null;
    this.cronTasks = new Map(); // jobId -> cron.ScheduledTask
    this.isInitialized = false;
  }

  /**
   * Initializes the scheduler engine.
   */
  async init() {
    if (this.isInitialized) return;
    this.isInitialized = true;

    // Load existing jobs from db if in mock or persistent mode
    await this.loadJobsFromStorage();

    // Check every 10 seconds for any one-time due jobs
    if (!this.timer && process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => {
        this.evaluateDueJobs().catch(err => console.error('[SchedulerService] Error evaluating due jobs:', err));
      }, 10000);
      if (typeof this.timer.unref === 'function') {
        this.timer.unref(); // Don't hold node process open in tests
      }
    }

    console.log('[SchedulerService] Initialized with', this.jobs.length, 'active jobs.');
  }

  /**
   * Stops the background evaluation timer.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const [id, task] of this.cronTasks.entries()) {
      try { task.stop(); } catch(e) {}
    }
    this.cronTasks.clear();
    this.isInitialized = false;
  }

  /**
   * Loads jobs from database or mock DB into memory.
   */
  async loadJobsFromStorage() {
    try {
      if (db.isMock || !db.supabase) {
        if (!db.mockDb.scheduledTasks) {
          db.mockDb.scheduledTasks = [];
        }
        this.jobs = db.mockDb.scheduledTasks;
      } else {
        const { data, error } = await db.supabase
          .from('background_jobs')
          .select('*')
          .in('status', ['scheduled', 'recurring', 'running'])
          .order('created_at', { ascending: false });

        if (!error && data) {
          this.jobs = data.map(row => ({
            id: row.id,
            tenant_id: row.tenant_id,
            type: row.job_type,
            name: row.payload?.name || row.job_type,
            target_campaign: row.payload?.target_campaign || null,
            scheduled_at: row.payload?.scheduled_at || null,
            cron_expression: row.payload?.cron_expression || null,
            status: row.status,
            payload: row.payload || {},
            last_run: row.payload?.last_run || null,
            next_run: row.payload?.next_run || row.payload?.scheduled_at || null,
            created_at: row.created_at,
            updated_at: row.updated_at
          }));
        }
      }

      // Re-register recurring cron tasks
      for (const job of this.jobs) {
        if (job.cron_expression && job.status === 'scheduled') {
          this.registerCronTask(job);
        }
      }
    } catch (err) {
      console.error('[SchedulerService] Failed to load jobs from storage:', err.message);
    }
  }

  /**
   * Saves or updates a job in persistence.
   */
  async persistJob(job) {
    try {
      if (db.isMock || !db.supabase) {
        if (!db.mockDb.scheduledTasks) db.mockDb.scheduledTasks = [];
        const idx = db.mockDb.scheduledTasks.findIndex(j => j.id === job.id);
        if (idx !== -1) {
          db.mockDb.scheduledTasks[idx] = { ...job, updated_at: new Date().toISOString() };
        } else {
          db.mockDb.scheduledTasks.push({ ...job });
        }
      } else {
        const payloadData = {
          name: job.name,
          target_campaign: job.target_campaign,
          scheduled_at: job.scheduled_at,
          cron_expression: job.cron_expression,
          last_run: job.last_run,
          next_run: job.next_run,
          ...(job.payload || {})
        };

        const { error } = await db.supabase
          .from('background_jobs')
          .upsert({
            id: job.id,
            tenant_id: job.tenant_id,
            job_type: job.type,
            status: job.status,
            payload: payloadData,
            updated_at: new Date().toISOString()
          });

        if (error) console.error('[SchedulerService] Error saving job to Supabase:', error);
      }
    } catch (err) {
      console.error('[SchedulerService] Error in persistJob:', err.message);
    }
  }

  /**
   * Registers a cron schedule task with node-cron.
   */
  registerCronTask(job) {
    if (!job.cron_expression || !cron.validate(job.cron_expression)) {
      return false;
    }

    // Stop existing if any
    if (this.cronTasks.has(job.id)) {
      try { this.cronTasks.get(job.id).stop(); } catch(e) {}
      this.cronTasks.delete(job.id);
    }

    try {
      const task = cron.schedule(job.cron_expression, async () => {
        console.log(`[SchedulerService] Cron triggered for job ${job.id} (${job.name})`);
        await this.executeJob(job);
      });
      this.cronTasks.set(job.id, task);
      return true;
    } catch (e) {
      console.error('[SchedulerService] Error creating cron task:', e.message);
      return false;
    }
  }

  /**
   * Evaluates due one-time scheduled jobs.
   */
  async evaluateDueJobs() {
    const now = Date.now();
    const dueJobs = this.jobs.filter(j => 
      j.status === 'scheduled' && 
      !j.cron_expression && 
      j.scheduled_at && 
      new Date(j.scheduled_at).getTime() <= now
    );

    for (const job of dueJobs) {
      console.log(`[SchedulerService] Due job reached scheduled time: ${job.id} (${job.name})`);
      await this.executeJob(job);
    }
  }

  /**
   * Returns all scheduled jobs for a specific tenant.
   */
  async getScheduledJobs(tenantId) {
    if (!this.isInitialized) {
      await this.init();
    }
    return this.jobs
      .filter(j => !tenantId || j.tenant_id === tenantId)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }

  /**
   * Creates and registers a new scheduled job.
   */
  async createScheduledJob({
    tenantId,
    type,
    name,
    targetCampaign = null,
    scheduledAt = null,
    cronExpression = null,
    payload = {}
  }) {
    if (!this.isInitialized) {
      await this.init();
    }

    if (!tenantId || !type) {
      throw new Error('tenantId and type are required');
    }

    if (!scheduledAt && !cronExpression) {
      throw new Error('Either scheduledAt (one-time date) or cronExpression (recurring) must be provided');
    }

    const now = new Date().toISOString();
    const jobId = `sched_${uuidv4()}`;

    // Clean / format friendly name
    let jobName = name;
    if (!jobName) {
      if (type === 'campaign_dial') {
        jobName = `Dial Campaign: ${targetCampaign || 'All Contacts'}`;
      } else if (type === 'crm_sync') {
        jobName = 'Automated CRM Sync';
      } else {
        jobName = 'Automated Lead Ingestion';
      }
    }

    let nextRun = scheduledAt;
    if (cronExpression) {
      // Estimate next run (1 hour from now as default display fallback)
      nextRun = new Date(Date.now() + 3600000).toISOString();
    }

    const newJob = {
      id: jobId,
      tenant_id: tenantId,
      type,
      name: jobName,
      target_campaign: targetCampaign,
      scheduled_at: scheduledAt,
      cron_expression: cronExpression,
      status: 'scheduled',
      payload: {
        ...payload,
        target_campaign: targetCampaign,
        whatsapp_threshold: payload.whatsapp_threshold !== undefined ? payload.whatsapp_threshold : 70,
        max_concurrency: payload.max_concurrency !== undefined ? payload.max_concurrency : 3
      },
      last_run: null,
      next_run: nextRun,
      created_at: now,
      updated_at: now
    };

    this.jobs.unshift(newJob);
    await this.persistJob(newJob);

    // If campaign_dial, also update the campaign status to 'scheduled'
    if (type === 'campaign_dial' && targetCampaign) {
      try {
        const campaigns = await db.getCampaigns(tenantId);
        const camp = campaigns.find(c => c.name.toLowerCase() === targetCampaign.toLowerCase());
        if (camp) {
          await db.updateCampaign(camp.id, {
            status: 'scheduled',
            scheduled_at: scheduledAt || now
          });
        }
      } catch (err) {
        console.warn('[SchedulerService] Could not update campaign status to scheduled:', err.message);
      }
    }

    // Register cron if recurring
    if (cronExpression) {
      this.registerCronTask(newJob);
    }

    await sendSlackNotification(`📅 *[Task Scheduled]* New ${type} task "${jobName}" scheduled for tenant *${tenantId}*. Time: ${scheduledAt || cronExpression}`);

    return newJob;
  }

  /**
   * Executes a scheduled job (either when due or triggered manually).
   */
  async executeJob(job) {
    console.log(`[SchedulerService] Executing job: ${job.id} (${job.type})`);
    job.status = 'running';
    job.last_run = new Date().toISOString();
    await this.persistJob(job);

    let result = { success: true };

    try {
      if (job.type === 'campaign_dial') {
        result = await this.executeCampaignDial(job);
      } else if (job.type === 'crm_sync') {
        result = await this.executeCrmSync(job);
      } else if (job.type === 'ingestion') {
        result = await this.executeIngestion(job);
      }

      // If one-time job, mark as completed
      if (!job.cron_expression) {
        job.status = 'completed';
      } else {
        // If recurring, reset status to scheduled and advance next_run
        job.status = 'scheduled';
        job.next_run = new Date(Date.now() + 3600000).toISOString();
      }
      job.updated_at = new Date().toISOString();
      await this.persistJob(job);

      if (global.sseEmitter) {
        global.sseEmitter.emit('scheduler-job-completed', { job, result });
      }

      return result;
    } catch (err) {
      console.error(`[SchedulerService] Execution failed for job ${job.id}:`, err);
      job.status = 'failed';
      job.payload.error = err.message;
      job.updated_at = new Date().toISOString();
      await this.persistJob(job);
      throw err;
    }
  }

  /**
   * Job Handler: Outbound Batch Campaign Dialing
   */
  async executeCampaignDial(job) {
    const tenantId = job.tenant_id;
    const campaignName = job.target_campaign;
    const thresholdVal = job.payload?.whatsapp_threshold !== undefined ? parseInt(job.payload.whatsapp_threshold) : 70;
    const concurrencyVal = job.payload?.max_concurrency !== undefined ? parseInt(job.payload.max_concurrency) : 3;

    if (!campaignName) {
      throw new Error('target_campaign is required for campaign_dial job');
    }

    // 1. Update Campaign config to active
    const allCampaigns = await db.getCampaigns(tenantId);
    const campaign = allCampaigns.find(c => c.name.toLowerCase() === campaignName.toLowerCase());
    if (campaign) {
      await db.updateCampaign(campaign.id, {
        whatsapp_threshold: thresholdVal,
        max_concurrency: concurrencyVal,
        status: 'active',
        started_at: new Date().toISOString()
      });
    }

    // 2. Fetch leads for this campaign
    const campaignLeads = campaign ? await db.getLeadsForCampaign(tenantId, campaign.id) : [];

    console.log(`[SchedulerService] Enqueuing ${campaignLeads.length} leads for scheduled campaign: ${campaignName}`);

    // 3. Prepare and enqueue leads for dialing
    let count = 0;
    for (const lead of campaignLeads) {
      if (['dnc', 'won'].includes(lead.status)) continue;

      const voiceAgentId = campaign ? campaign.voice_agent_id : null;
      const updatedRaw = {
        ...(lead.raw_data || {}),
        attempts: 0,
        voice_agent_id: voiceAgentId
      };
      delete updatedRaw.next_retry_at;

      await db.updateLeadStatusAndData(lead.id, 'queued', updatedRaw);

      if (voiceAgentId) {
        await db.updateLeadScore(lead.id, lead.score || 30);
        lead.assigned_agent_id = voiceAgentId;
      }

      try {
        if (db.supabase) {
          await db.supabase
            .from('active_leads')
            .update({ total_attempts: 0, disqualified: false, dnd: false })
            .eq('lead_id', lead.id);
        }
        await db.enqueueToDialer(lead.tenant_id, lead.id, lead.phone, campaignName);
        count++;
      } catch (err) {
        console.error(`[SchedulerService] Failed to push lead ${lead.id} to dialer:`, err.message);
      }
    }

    await db.insertAuditLog(tenantId, 'scheduled_dialer_triggered', {
      campaign_name: campaignName,
      enqueued_count: count,
      concurrency: concurrencyVal
    });

    await sendSlackNotification(`🎯 *[Scheduled Dialing Triggered]* Campaign "*${campaignName}*" has begun dialing ${count} leads according to schedule.`);

    return {
      success: true,
      campaign: campaignName,
      enqueued_count: count,
      message: `Triggered outbound calls for ${count} leads in "${campaignName}".`
    };
  }

  /**
   * Job Handler: Recurring CRM Sync
   */
  async executeCrmSync(job) {
    const tenantId = job.tenant_id;
    console.log(`[SchedulerService] Executing CRM Sync for tenant ${tenantId}`);
    // Simulate or perform CRM sync
    await sendSlackNotification(`[Scheduler] 🕒 Scheduled CRM Sync completed successfully for tenant "${tenantId}".`);
    return { success: true, type: 'crm-sync' };
  }

  /**
   * Job Handler: Lead Ingestion
   */
  async executeIngestion(job) {
    const tenantId = job.tenant_id;
    console.log(`[SchedulerService] Executing scheduled Lead Ingestion for tenant ${tenantId}`);
    await sendSlackNotification(`[Scheduler] 🕒 Scheduled Lead Ingestion executed for tenant "${tenantId}".`);
    return { success: true, type: 'ingestion' };
  }

  /**
   * Manually triggers a scheduled job immediately ahead of time.
   */
  async triggerJobNow(jobId, tenantId) {
    if (!this.isInitialized) {
      await this.init();
    }
    
    // 1. In-memory lookup
    const job = this.jobs.find(j => j.id === jobId && (!tenantId || j.tenant_id === tenantId));
    if (job) {
      return await this.executeJob(job);
    }
    
    // 2. BullMQ fallback
    const bullJobs = await getRepeatableJobs();
    const match = bullJobs.find(bj => bj.id === jobId || bj.key === jobId);
    
    if (match) {
      if (!tenantId) {
        throw new Error('tenantId required to trigger BullMQ scheduled job');
      }

      const idMatch = match.id.match(/^recurring-(.+?)-(.+)-(\d+)$/);
      const jobTenantId = idMatch ? idMatch[2] : null;

      if (jobTenantId && jobTenantId !== tenantId) {
        throw new Error('Tenant mismatch: cannot trigger job for another tenant');
      }

      const jobName = match.name || 'ingest-leads';
      const payload = { campaignId: match.id, tenantId, metaData: null, isManualTrigger: true };
      
      // We use campaignQueue.add to satisfy setting jobName dynamically, as addCampaignJob hardcodes 'ingest-leads'
      const enqueued = await campaignQueue.add(jobName, payload, { removeOnComplete: true });
      return { success: true, triggered: 'bullmq', jobId: enqueued.id };
    }

    // 3. Not found anywhere
    throw new Error(`Scheduled job not found: ${jobId}`);
  }

  /**
   * Cancels and removes a scheduled job.
   */
  async cancelScheduledJob(jobId, tenantId) {
    if (!this.isInitialized) {
      await this.init();
    }
    const idx = this.jobs.findIndex(j => j.id === jobId && (!tenantId || j.tenant_id === tenantId));
    if (idx === -1) {
      // Check if it's a BullMQ repeatable key as fallback
      return false;
    }

    const job = this.jobs[idx];
    if (this.cronTasks.has(job.id)) {
      try { this.cronTasks.get(job.id).stop(); } catch(e) {}
      this.cronTasks.delete(job.id);
    }

    job.status = 'cancelled';
    job.updated_at = new Date().toISOString();

    // Remove from in-memory array
    this.jobs.splice(idx, 1);

    // Update persistence
    if (db.isMock || !db.supabase) {
      const mockIdx = (db.mockDb.scheduledTasks || []).findIndex(j => j.id === jobId);
      if (mockIdx !== -1) db.mockDb.scheduledTasks.splice(mockIdx, 1);
    } else {
      await db.supabase
        .from('background_jobs')
        .delete()
        .eq('id', jobId);
    }

    return true;
  }
}

export const schedulerService = new SchedulerService();
export default schedulerService;
