import db from '../config/db.js';
import { sendSlackNotification } from './slackService.js';

export async function dialAllCampaignLeads(tenant_id, campaign_name, whatsapp_threshold = 70, max_concurrency = 3, limitParam = null, isDryRun = false) {
  const normalizedTarget = decodeURIComponent(campaign_name).trim().toLowerCase();

  const campaigns = await db.getCampaigns(tenant_id);
  const campaign = campaigns.find(c => 
    c.id === campaign_name || 
    c.name.toLowerCase() === normalizedTarget ||
    c.name.toLowerCase().replace(/\s+/g, '') === normalizedTarget.replace(/\s+/g, '')
  );

  const effectiveCampaignName = campaign ? campaign.name : campaign_name;

  const targetName = campaign ? campaign.name.toLowerCase() : normalizedTarget;
  const rawCampaignLeads = campaign
    ? await db.getLeadsForCampaign(tenant_id, campaign.id)
    : [];

  let eligibleLeads = rawCampaignLeads.filter(l => !['dnc', 'won'].includes(l.status));
  eligibleLeads.sort((a, b) => ((b.score ?? 0) - (a.score ?? 0)) || (new Date(a.created_at || 0) - new Date(b.created_at || 0)));

  const selectedLeads = (limitParam !== null && !isNaN(limitParam) && limitParam >= 0)
    ? eligibleLeads.slice(0, limitParam)
    : eligibleLeads;

  if (isDryRun) {
    const wouldEnqueueCount = selectedLeads.length;
    const sampleLeadIds = selectedLeads.slice(0, 5).map(l => l.id);
    return {
      success: true,
      dry_run: true,
      campaign: effectiveCampaignName,
      campaign_id: campaign ? campaign.id : null,
      would_enqueue_count: wouldEnqueueCount,
      count: wouldEnqueueCount,
      sample_lead_ids: sampleLeadIds,
      first_5_lead_ids: sampleLeadIds,
      limit: limitParam,
      message: `Dry run: ${wouldEnqueueCount} leads would be enqueued for dialing.`
    };
  }

  // Pause guard: do not run if campaign is actively paused (use resume endpoint instead)
  if (campaign && campaign.status === 'paused') {
    console.log(`[Batch Dialer] Skip: campaign ${campaign.id} status=${campaign.status}`);
    return {
      success: false, skipped: true, reason: 'campaign_not_active_or_draft',
      message: 'Campaign is paused. Resume the campaign to continue dialing.',
      campaign: effectiveCampaignName, campaign_id: campaign.id, count: 0
    };
  }

  if (campaign) {
    if (db.supabase) {
      const lockoutMs = parseInt(process.env.DIAL_ALL_LOCKOUT_MS) || 30000;
      const recentCutoff = new Date(Date.now() - lockoutMs).toISOString();
      const { data: recentEnqueues } = await db.supabase
        .from('call_queue')
        .select('queue_id, created_at')
        .eq('campaign_id', campaign.id)
        .gte('created_at', recentCutoff)
        .limit(1);

      if (recentEnqueues && recentEnqueues.length > 0) {
        throw new Error('Dial-all already triggered in the last 30 seconds for this campaign. Wait 30s and try again.');
      }
    }

    await db.updateCampaign(campaign.id, {
      whatsapp_threshold: whatsapp_threshold,
      max_concurrency: max_concurrency,
      status: 'active',
      started_at: new Date().toISOString()
    });

    if (db.supabase) {
      try {
        const { data: stuckSlots } = await db.supabase
          .from('concurrency_slots')
          .select('call_id')
          .eq('campaign_id', campaign.id)
          .eq('released', false);

        if (stuckSlots && stuckSlots.length > 0) {
          for (const s of stuckSlots) {
            await db.supabase.rpc('fn_release_slot', { p_call_id: s.call_id });
          }
        }
      } catch (cleanErr) {
        console.warn('[Batch Dialer] Failed to release old campaign slots:', cleanErr);
      }
    }
  }

  console.log(`[Batch Dialer] Enqueuing ${selectedLeads.length} leads for campaign: "${targetName}" with concurrency: ${max_concurrency}, WA threshold: ${whatsapp_threshold} (limit: ${limitParam ?? 'none'})`);

  let skipped_already_queued = 0;
  let enqueued_actually = 0;

  if (campaign && db.supabase) {
    // 1. Fetch all existing queue rows for this campaign in ONE query
    const { data: existingQueueRows } = await db.supabase
      .from('call_queue')
      .select('queue_id, phone, status, active_lead_id')
      .eq('campaign_id', campaign.id);

    const queueByPhone = new Map();
    const pausedQueueIds = [];
    (existingQueueRows || []).forEach(row => {
      queueByPhone.set(row.phone, row);
      if (row.status === 'paused') pausedQueueIds.push(row.queue_id);
    });

    if (pausedQueueIds.length > 0) {
      await db.supabase
        .from('call_queue')
        .update({ status: 'queued', next_attempt_at: new Date().toISOString() })
        .in('queue_id', pausedQueueIds);
    }

    // Only skip calls that are ACTUALLY IN-FLIGHT right now
    const inFlightPhones = new Set(
      (existingQueueRows || [])
        .filter(r => ['queued', 'calling', 'in_flight', 'dispatched', 'dialing'].includes(r.status))
        .map(r => r.phone)
    );

    const leadsToEnqueue = [];
    for (const lead of selectedLeads) {
      if (!lead.phone) continue;
      if (inFlightPhones.has(lead.phone)) {
        skipped_already_queued++;
      } else {
        leadsToEnqueue.push(lead);
      }
    }

    const voiceAgentId = campaign ? campaign.voice_agent_id : null;
    const CHUNK_SIZE = 200;

    for (let i = 0; i < leadsToEnqueue.length; i += CHUNK_SIZE) {
      const chunk = leadsToEnqueue.slice(i, i + CHUNK_SIZE);
      const leadIds = chunk.map(l => l.id);

      // Fetch active_leads for this chunk
      const { data: existingActive } = await db.supabase
        .from('active_leads')
        .select('active_lead_id, lead_id')
        .eq('campaign_id', campaign.id)
        .in('lead_id', leadIds);

      const activeMap = new Map();
      (existingActive || []).forEach(a => activeMap.set(a.lead_id, a.active_lead_id));

      const missingActive = chunk
        .filter(l => !activeMap.has(l.id))
        .map(l => ({
          tenant_id,
          campaign_id: campaign.id,
          lead_id: l.id,
          phone: l.phone,
          total_attempts: 0,
          disqualified: false,
          dnd: false
        }));

      if (missingActive.length > 0) {
        const { data: insertedActive } = await db.supabase
          .from('active_leads')
          .insert(missingActive)
          .select('active_lead_id, lead_id');
        if (insertedActive) {
          insertedActive.forEach(a => activeMap.set(a.lead_id, a.active_lead_id));
        }
      }

      if (existingActive && existingActive.length > 0) {
        await db.supabase
          .from('active_leads')
          .update({ total_attempts: 0, disqualified: false, dnd: false })
          .in('active_lead_id', existingActive.map(a => a.active_lead_id));
      }

      const scheduledAt = new Date().toISOString();
      const queueToInsert = [];
      const queueIdsToReset = [];

      for (const lead of chunk) {
        const activeLeadId = activeMap.get(lead.id);
        if (!activeLeadId) continue;

        const existingQ = queueByPhone.get(lead.phone);
        if (existingQ) {
          queueIdsToReset.push(existingQ.queue_id);
        } else {
          queueToInsert.push({
            tenant_id,
            campaign_id: campaign.id,
            active_lead_id: activeLeadId,
            phone: lead.phone,
            attempt_number: 1,
            status: 'queued',
            next_attempt_at: scheduledAt
          });
        }
      }

      if (queueIdsToReset.length > 0) {
        await db.supabase
          .from('call_queue')
          .update({
            status: 'queued',
            attempt_number: 1,
            next_attempt_at: scheduledAt,
            provisional_call_id: null,
            updated_at: scheduledAt
          })
          .in('queue_id', queueIdsToReset);
      }

      if (queueToInsert.length > 0) {
        await db.supabase
          .from('call_queue')
          .insert(queueToInsert);
      }

      // Update leads table
      await db.supabase
        .from('leads')
        .update({ status: 'queued', updated_at: scheduledAt })
        .in('id', leadIds);

      enqueued_actually += chunk.length;
    }
  } else {
    // MockDb / Offline mode for unit tests
    const voiceAgentId = campaign ? campaign.voice_agent_id : null;
    for (const lead of selectedLeads) {
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
      await db.enqueueToDialer(lead.tenant_id, lead.id, lead.phone, effectiveCampaignName);
      enqueued_actually++;
    }
  }

  const enqueuedCount = enqueued_actually;
  const startTimeStr = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' });
  const startSlackMsg = [
    `🚀 *[Campaign Started]* Outbound dialing has started for *${effectiveCampaignName}*`,
    `• *Total Leads Enqueued:* ${enqueuedCount}`,
    `• *Concurrency Limit:* ${max_concurrency || 3} concurrent calls`,
    `• *Tenant:* ${tenant_id}`,
    `• *Started At:* ${startTimeStr} IST`,
    `• *Voice Agent:* ${campaign?.voice_agent_id || 'Default AI Voicebot'}`
  ].join('\n');
  await sendSlackNotification(startSlackMsg);

  import('../workers/dispatcher.js').then(d => {
    if (d.default && typeof d.default.tick === 'function') {
      d.default.tick().catch(e => console.error('[Batch Dialer] Immediate dispatcher tick error:', e));
    }
  }).catch(() => {});

  return {
    success: true,
    campaign: effectiveCampaignName,
    campaign_id: campaign ? campaign.id : null,
    message: `Successfully enqueued ${enqueued_actually} campaign leads for dialing (skipped ${skipped_already_queued} active).`,
    count: enqueued_actually,
    enqueued: enqueued_actually,
    enqueued_leads: enqueued_actually,
    skipped_already_queued,
    limit: limitParam
  };
}

// In-memory locks to prevent concurrent and duplicate campaign completion notifications
const completingCampaigns = new Set();
const completedCampaignCache = new Map(); // campaignId -> timestamp

/**
 * Checks if all queued and active calls for a campaign are finished,
 * updates the campaign status to 'completed', and sends a comprehensive Slack report.
 */
export async function checkAndNotifyCampaignCompletion(campaignId) {
  if (!campaignId || !db.supabase) return false;

  // Concurrency guard: prevent duplicate parallel execution within this process
  if (completingCampaigns.has(campaignId)) {
    console.log(`[CampaignDialer] Campaign completion check already in progress for ${campaignId}. Skipping.`);
    return false;
  }

  // Deduplication guard: do not re-notify if completed within last 15 minutes
  const lastCompleted = completedCampaignCache.get(campaignId);
  if (lastCompleted && (Date.now() - lastCompleted) < 15 * 60 * 1000) {
    console.log(`[CampaignDialer] Campaign ${campaignId} was already completed recently (${Math.round((Date.now() - lastCompleted) / 1000)}s ago). Skipping.`);
    return false;
  }

  completingCampaigns.add(campaignId);

  try {
    const { data: campaign, error: campErr } = await db.supabase
      .from('campaigns')
      .select('*')
      .eq('id', campaignId)
      .single();

    if (campErr || !campaign || campaign.status !== 'active') return false;

    // Check if any leads in call_queue are still queued or in progress
    const { count: pendingQueueCount } = await db.supabase
      .from('call_queue')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .in('status', ['queued', 'calling', 'dispatched']);

    if (typeof pendingQueueCount === 'number' && pendingQueueCount > 0) return false;

    // Also verify no active sessions in call_sessions
    const { count: activeSessionsCount } = await db.supabase
      .from('call_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('campaign_id', campaign.id)
      .in('disposition', ['calling', 'in-progress'])
      .is('ended_at', null);

    if (typeof activeSessionsCount === 'number' && activeSessionsCount > 0) return false;

    // Fetch all leads for this campaign via getLeadsForCampaign (checks junction table and campaign_name)
    const leads = await db.getLeadsForCampaign(campaign.tenant_id, campaign.id);
    const totalLeads = (leads && leads.length > 0) ? leads.length : (campaign.total_leads || 0);
    if (totalLeads === 0) return false;

    // Verify no unattempted leads remain for this campaign
    const unattemptedLeads = (leads || []).filter(l => ['queued', 'ingested'].includes(l.status));
    if (unattemptedLeads.length > 0) return false;

    let hotCount = 0;
    let warmCount = 0;
    let qualifiedCount = 0;
    let connectedCount = 0;
    let completedDials = 0;

    leads?.forEach(l => {
      const s = l.score || 0;
      const st = (l.status || '').toLowerCase();
      if (st === 'hot_escalated' || s >= 80) hotCount++;
      else if (s >= 65) qualifiedCount++;
      else if (s >= 50) warmCount++;

      if (['called', 'completed', 'interested', 'enrolled', 'hot_escalated'].includes(st)) {
        connectedCount++;
      }
      if (['called', 'completed', 'interested', 'enrolled', 'hot_escalated', 'closed', 'failed'].includes(st)) {
        completedDials++;
      }
    });

    // Guard: don't complete if 0 dials finished
    if (completedDials === 0) return false;

    const finishDate = new Date();
    const finishIso = finishDate.toISOString();

    // Atomically update campaign status to 'completed' with .select('id')
    // Postgres will only return updated rows if status was ACTUALLY 'active'.
    const { data: updatedRows, error: updateErr } = await db.supabase
      .from('campaigns')
      .update({
        status: 'completed',
        finished_at: finishIso,
        connected: connectedCount,
        processed_leads: completedDials
      })
      .eq('id', campaign.id)
      .eq('status', 'active') // Concurrency guard: only update if still 'active'
      .select('id');

    if (updateErr) {
      console.warn('[CampaignDialer] Could not update campaign to completed:', updateErr.message);
      return false;
    }

    // If 0 rows were updated, another process already completed it
    if (!updatedRows || updatedRows.length === 0) {
      console.log(`[CampaignDialer] Campaign "${campaign.name}" (${campaign.id}) was already marked completed by another worker. Skipping duplicate alert.`);
      completedCampaignCache.set(campaign.id, Date.now());
      return false;
    }

    // Record in local cache to prevent re-triggering from local polling
    completedCampaignCache.set(campaign.id, Date.now());

    // Format times in IST
    const startedAtDate = campaign.started_at ? new Date(campaign.started_at) : null;
    const startedStr = startedAtDate
      ? startedAtDate.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST'
      : 'Earlier today';
    const finishStr = finishDate.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST';

    let elapsedStr = 'N/A';
    if (startedAtDate) {
      const diffMs = finishDate.getTime() - startedAtDate.getTime();
      const hours = Math.floor(diffMs / (1000 * 60 * 60));
      const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
      elapsedStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }

    const completionMsg = [
      `🎉 *[Campaign Completed]* ${campaign.name} is completed! Outbound calling successfully finished.`,
      `• *Total Leads Enrolled:* ${totalLeads}`,
      `• *Total Contacts Dialed:* ${completedDials} (${Math.round((completedDials / totalLeads) * 100)}%)`,
      `• *Connected / Answered:* ${connectedCount} (${Math.round((connectedCount / totalLeads) * 100)}%)`,
      `• *High-Intent (HOT / Qualified):* ${hotCount + qualifiedCount} leads`,
      `• *Warm Leads / Follow-ups:* ${warmCount} leads`,
      `• *Started At:* ${startedStr}`,
      `• *Finished At:* ${finishStr}`,
      `• *Total Runtime:* ${elapsedStr}`,
      `• *Tenant:* ${campaign.tenant_id}`,
      `• *Voice Agent:* ${campaign.voice_agent_id || 'AI Agent'}`,
      `📊 Detailed lead records, conversational audio recordings, and calibrated transcripts are now finalized in the dashboard.`
    ].join('\n');

    try {
      await sendSlackNotification(completionMsg);
      console.log(`[CampaignDialer] Successfully sent campaign completed Slack notification for "${campaign.name}"`);
    } catch (err) {
      console.error('[CampaignDialer] Failed to send completion Slack message:', err);
    }

    return true;
  } finally {
    completingCampaigns.delete(campaignId);
  }
}

