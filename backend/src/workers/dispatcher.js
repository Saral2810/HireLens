import { v4 as uuidv4 } from 'uuid';
import db from '../config/db.js';
import voiceProviderFactory from '../services/voiceProvider/index.js';
import { isCallable, nextCallableSlot } from '../services/queueService.js';

export const dispatcherLogs = [];
const MAX_LOGS = 20;
function pushLog(msg) {
  const entry = `[${new Date().toISOString()}] ${msg}`;
  console.log(entry);
  dispatcherLogs.push(entry);
  if (dispatcherLogs.length > MAX_LOGS) {
    dispatcherLogs.shift();
  }
}


class DispatcherWorker {
  constructor() {
    this.isRunning = false;
    this.runId = uuidv4();
    this.intervalId = null;
  }

  start() {
    console.log(`[Dispatcher] Starting polling worker (Run ID: ${this.runId})`);

    // Temporary keep-alive self-ping for free-tier spin-down mitigation
    if (process.env.KEEP_ALIVE_SELF_PING === 'true' && process.env.PUBLIC_APP_URL) {
      const baseUrl = process.env.PUBLIC_APP_URL.replace(/\/+$/, '');
      console.log(`[Dispatcher] Starting keep-alive self-ping to ${baseUrl}/health every 4 minutes`);
      setInterval(() => {
        fetch(`${baseUrl}/health`)
          .then(res => console.log(`[Dispatcher] Keep-alive ping successful (${res.status})`))
          .catch(err => console.error(`[Dispatcher] Keep-alive ping failed:`, err.message));
      }, 4 * 60 * 1000); // 4 minutes
    }

    
    const pollInterval = parseInt(process.env.DIALER_POLL_INTERVAL_MS) || 5000;
    console.log(`[Dispatcher] Polling interval set to ${pollInterval}ms`);

    const TICK_TIMEOUT_MS = parseInt(process.env.DIALER_TICK_TIMEOUT_MS) || 30000;

    this.intervalId = setInterval(async () => {
      if (this.isRunning) {
        console.log('[Dispatcher] Previous tick still running, skipping...');
        return;
      }

      this.isRunning = true;
      const tickStart = Date.now();
      try {
        await Promise.race([
          this.tick(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Tick exceeded ${TICK_TIMEOUT_MS}ms — forcing reset`)), TICK_TIMEOUT_MS)
          )
        ]);
      } catch (error) {
        console.error(`[Dispatcher] Error in tick (elapsed=${Date.now() - tickStart}ms):`, error?.message || error);
        try {
          await db.supabase?.rpc('fn_dispatch_release', { p_run_id: this.runId });
        } catch (_) {}
      } finally {
        this.isRunning = false;
      }
    }, pollInterval);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log(`[Dispatcher] Polling worker stopped.`);
    }
  }

  async tick() {
    // Kill-switch: set DIALER_ENABLED=false to halt all dialing without a redeploy
    if (process.env.DIALER_ENABLED === 'false') {
      console.log('[Dispatcher] DIALER_ENABLED=false — skipping tick.');
      return;
    }

    if (db.isMock) {
      console.log('[Dispatcher] Skipping dialer tick in mock mode.');
      return;
    }

    const supabase = db.supabase;

    // 1. Claim the run
    const { data: acquired, error: acquireError } = await supabase
      .rpc('fn_dispatch_acquire', { p_run_id: this.runId });

    if (acquireError || !acquired) {
      console.log('[Dispatcher] Could not acquire lease or lease held by another worker.');
      return;
    }

    // Reap stranded dispatches to free up concurrency limits
    try {
      await supabase.rpc('reap_stale_slots', { p_older_than_secs: 240 });
    } catch (reapErr) {
      console.warn('[Dispatcher] Slot reap failed:', reapErr?.message || reapErr);
    }
    try {
      await supabase.rpc('fn_reap_stranded_dispatches');
    } catch (reapErr) {
      console.warn('[Dispatcher] Queue cleanup reap failed:', reapErr?.message || reapErr);
    }

    // Reconcile stranded abandoned calling sessions older than 3 minutes
    try {
      const STALE_TIMEOUT_MS = parseInt(process.env.STALE_CALL_TIMEOUT_MS) || (90 * 1000); // 90 seconds (grace period for webhook delivery)
      const staleCutoff = new Date(Date.now() - STALE_TIMEOUT_MS).toISOString();
      
      const { data: staleSessions, error: staleErr } = await supabase
        .from('call_sessions')
        .select('id, provider_session_id, lead_id, tenant_id, campaign_id')
        .eq('disposition', 'calling')
        .lt('started_at', staleCutoff);

      const { handleCallOutcome } = await import('../services/queueService.js');

      if (!staleErr && staleSessions && staleSessions.length > 0) {
        console.log(`[Dispatcher] Found ${staleSessions.length} stranded call session(s) older than 3m. Checking provider artifacts...`);
        for (const staleSess of staleSessions) {
          try {
            let reconciledDisp = 'no_answer';
            let duration = 0;
            let summary = 'Call was not answered / timed out.';
            let transcript = null;
            let sentiment = '';
            let recordingUrl = null;
            let structuredOutputs = null;

            const isSimulated = !staleSess.provider_session_id ||
              staleSess.provider_session_id.startsWith('mock-') ||
              staleSess.provider_session_id.startsWith('sim-');
            if (!isSimulated) {
              try {
                let providerType = process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
                if (staleSess.campaign_id && supabase) {
                  try {
                    const { data: camp } = await supabase.from('campaigns').select('voice_provider').eq('id', staleSess.campaign_id).maybeSingle();
                    if (camp?.voice_provider) providerType = camp.voice_provider;
                  } catch (_) {}
                }
                const provider = await voiceProviderFactory.getProvider(staleSess.tenant_id, providerType);
                const artifacts = await provider.fetchArtifacts(staleSess.provider_session_id, staleSess);
                const hasValidTranscript = artifacts?.transcript && (
                  typeof artifacts.transcript === 'string' ? artifacts.transcript.trim().length > 0 :
                  Array.isArray(artifacts.transcript) ? artifacts.transcript.length > 0 :
                  !!(artifacts.transcript.messages?.length || artifacts.transcript.transcript_data?.messages?.length)
                );
                if (artifacts && (hasValidTranscript || artifacts.summary || (artifacts.disposition && !['calling', 'initiated', 'queued'].includes(artifacts.disposition)))) {
                  reconciledDisp = artifacts.disposition && !['calling', 'initiated', 'queued'].includes(artifacts.disposition) ? artifacts.disposition : 'completed';
                  duration = artifacts.duration_seconds || 0;
                  summary = artifacts.summary || summary;
                  transcript = artifacts.transcript || null;
                  sentiment = artifacts.sentiment || '';
                  recordingUrl = artifacts.recording_url || null;
                  structuredOutputs = artifacts.structured_outputs || null;
                }
              } catch (_) {}
            }

            await handleCallOutcome(
              staleSess.provider_session_id,
              reconciledDisp,
              duration,
              summary,
              transcript,
              sentiment,
              recordingUrl,
              structuredOutputs
            );
            console.log(`[Dispatcher] Reconciled stale session ${staleSess.provider_session_id} as ${reconciledDisp}.`);
          } catch (outErr) {
            console.error(`[Dispatcher] Failed to end stale session ${staleSess.provider_session_id}:`, outErr);
          }
        }
      }

      // Also reconcile any sessions whose call_queue row was reaped or marked 'failed'
      const { data: reapedQueueRows } = await supabase
        .from('call_queue')
        .select('provisional_call_id')
        .eq('status', 'failed')
        .not('provisional_call_id', 'is', null)
        .limit(20);

      if (reapedQueueRows && reapedQueueRows.length > 0) {
        const reapedCallIds = reapedQueueRows.map(r => r.provisional_call_id).filter(Boolean);
        const { data: reapedSessions } = await supabase
          .from('call_sessions')
          .select('id, provider_session_id, lead_id, tenant_id')
          .in('provider_session_id', reapedCallIds)
          .eq('disposition', 'calling');

        if (reapedSessions && reapedSessions.length > 0) {
          for (const s of reapedSessions) {
            await handleCallOutcome(s.provider_session_id, 'failed', 0, 'Dispatch reaped or failed').catch(() => {});
          }
        }
      }
    } catch (reconcileErr) {
      console.error('[Dispatcher] Error in stale call reconciliation:', reconcileErr);
    }

    try {
      // 2. Read the batch of due calls (skip paused rows so pause endpoint works instantly)
      let { data: queue, error: queueError } = await supabase
        .from('call_queue')
        .select(`
          queue_id,
          tenant_id,
          active_lead_id,
          campaign_id,
          phone,
          attempt_number,
          campaigns!inner(id, name, status, voice_agent_id, voice_provider),
          active_leads!inner(
            lead_id,
            leads!inner(*)
          )
        `)
        .eq('status', 'queued')
        .eq('campaigns.status', 'active')
        .lte('next_attempt_at', new Date().toISOString())
        .limit(50); // Fetch up to 50 due calls

      if (queueError) throw queueError;

      if (!queue || queue.length === 0) {
        // Auto-check if any active campaign has completed all dials & retries
        try {
          const { data: activeCamps } = await supabase
            .from('campaigns')
            .select('id')
            .eq('status', 'active');
          if (activeCamps && activeCamps.length > 0) {
            const { checkAndNotifyCampaignCompletion } = await import('../services/campaignDialer.js');
            for (const camp of activeCamps) {
              await checkAndNotifyCampaignCompletion(camp.id).catch(() => {});
            }
          }
        } catch (_) {}
        return; // Nothing to dial
      }

      // Belt-and-suspenders: filter out rows whose phone already has another row in status='calling'
      const phones = queue.map(r => r.phone).filter(Boolean);
      if (phones.length > 0) {
        const { data: activeCalls } = await supabase
          .from('call_queue')
          .select('phone')
          .in('phone', phones)
          .eq('status', 'calling');
        const busyPhones = new Set((activeCalls || []).map(r => r.phone));
        queue = queue.filter(r => {
          if (busyPhones.has(r.phone)) {
            console.log(`[Dispatcher] Skipped lead (phone ${r.phone}) — already calling on another campaign row.`);
            return false;
          }
          return true;
        });
      }

      if (queue.length === 0) {
        return; // Nothing left after filtering
      }

      console.log(`[Dispatcher] Found ${queue.length} due calls to process.`);

      // 3. Process each lead
      for (const lead of queue) {
        // Guard: skip if campaign is not active or has no voice agent configured
        const campaignStatus = lead.campaigns?.status;
        const voiceAgentId = lead.campaigns?.voice_agent_id;
        if (campaignStatus !== 'active') {
          pushLog(`[Dispatcher STAGE] SKIP queue_id=${lead.queue_id} campaign_status=${campaignStatus} — campaign must be active`);
          console.warn(`[Dispatcher] Skipping lead in non-active campaign: queue_id=${lead.queue_id}, campaign_id=${lead.campaign_id}, status=${campaignStatus}`);
          continue;
        }

        if (!voiceAgentId) {
          pushLog(`[Dispatcher STAGE] SKIP queue_id=${lead.queue_id} missing voice_agent_id on campaign`);
          console.warn(`[Dispatcher] Skipping lead in campaign without voice_agent_id: queue_id=${lead.queue_id}`);
          continue;
        }

        // Guard: skip leads that are already closed or on DNC — should never be dialed
        const leadStatus = lead.active_leads?.leads?.status;
        if (leadStatus === 'closed' || leadStatus === 'dnc') {
          pushLog(`[Dispatcher STAGE] SKIP queue_id=${lead.queue_id} lead_status=${leadStatus} — marking done`);
          console.warn(`[Dispatcher] Skipping closed/DNC lead in queue: queue_id=${lead.queue_id}, status=${leadStatus}`);
          await supabase
            .from('call_queue')
            .update({ status: 'done' })
            .eq('queue_id', lead.queue_id);
          continue;
        }

        // Guard: skip leads outside calling hours — snooze to next valid calling slot
        const onboardingCfg = await db.getOnboardingConfig(lead.tenant_id).catch(() => ({}));
        if (!isCallable(lead.active_leads?.leads || {}, onboardingCfg)) {
          // Use the same nextCallableSlot helper used at enqueue time for consistency
          const nextSlot = nextCallableSlot(onboardingCfg);
          pushLog(`[Dispatcher STAGE] OUTSIDE-HOURS queue_id=${lead.queue_id} — snoozing to ${nextSlot}`);
          await supabase
            .from('call_queue')
            .update({ next_attempt_at: nextSlot })
            .eq('queue_id', lead.queue_id);
          continue;
        }

        // We need a unique provisional ID before dialing so we can reserve the slot
        pushLog(`[Dispatcher STAGE] queue-fetch tenant=${lead.tenant_id} queue_id=${lead.queue_id} found=1`);
        const provisionalCallId = `pending-${lead.queue_id}-${Date.now()}`;

        // Reserve Slot
        const { data: slotRes, error: slotError } = await supabase
          .rpc('fn_reserve_slot', {
            p_tenant_id: lead.tenant_id,
            p_campaign_id: lead.campaign_id,
            p_call_id: provisionalCallId,
            p_run_id: this.runId
          });

        pushLog(`[Dispatcher STAGE] slot-reserve queue_id=${lead.queue_id} allowed=${slotRes && slotRes.length > 0 ? slotRes[0].allowed : false}`);
        if (slotError) {
          console.error(`[Dispatcher] Slot reserve error for ${lead.queue_id}:`, slotError);
          continue;
        }

        if (slotRes && slotRes.length > 0 && slotRes[0].allowed === true) {
          let currentSlotId = provisionalCallId;
          try {
            // Dial via Telephony Provider
            // placeCall() routes to the campaign's voice provider adapter (e.g. gnaniProvider.js)
            pushLog(`[Dispatcher STAGE] placeCall-start queue_id=${lead.queue_id} agent_id=${lead.campaigns?.voice_agent_id}`);
            const dialResult = await this.placeCall(lead, provisionalCallId);
            const realCallId = dialResult.callId;
            currentSlotId = realCallId || currentSlotId;
            pushLog(`[Dispatcher STAGE] placeCall-success queue_id=${lead.queue_id} provider_call_id=${realCallId}`);
            
            // Swap the provisional slot ID for the real provider call ID so the webhook can release it
            await supabase
              .from('concurrency_slots')
              .update({ call_id: realCallId })
              .eq('call_id', provisionalCallId);

            pushLog(`[Dispatcher STAGE] leads-update queue_id=${lead.queue_id} ok`);
            // Update the legacy leads table so the UI updates to 'calling' (preserving existing raw_data)
            await db.updateLeadStatusAndData(
              lead.active_leads.lead_id, 
              'calling', 
              lead.active_leads.leads.raw_data || {}
            );

            
            // Create the legacy call_sessions row that the webhook expects
            const callSession = await db.insertCallSession({
              tenant_id: lead.tenant_id,
              campaign_id: lead.campaign_id,
              lead_id: lead.active_leads.lead_id,
              provider_session_id: realCallId,
              disposition: 'calling'
            });

            pushLog(`[Dispatcher STAGE] callSessions-insert queue_id=${lead.queue_id} id=${callSession?.id}`);
            // Seed initial dialing event so Live Monitor event stream isn't empty.
            // Wrapped in its own try/catch — a call_events insert failure must NOT
            // kill the dispatch flow (would leave queue rows stuck at 'queued' forever).
            try {
              if (callSession && callSession.id) {
                await db.insertCallEvent({
                  tenant_id: lead.tenant_id,
                  session_id: callSession.id,
                  event_type: 'dialing',
                  payload: {
                    message: 'Outbound dial initiated to contact phone number.',
                    provider: lead.campaigns?.voice_provider || process.env.DEFAULT_VOICE_PROVIDER || 'gnani',
                    provider_session_id: realCallId
                  }
                });
              }
            } catch (eventErr) {
              console.warn('[Dispatcher] Failed to seed initial dialing event (non-fatal):', eventErr?.message || eventErr);
            }

            pushLog(`[Dispatcher STAGE] callEvents-insert queue_id=${lead.queue_id} (already wrapped in try/catch)`);
            // Update the queue with the real ID and mark it dispatched
            await supabase
              .from('call_queue')
              .update({ 
                status: 'dispatched',
                provisional_call_id: realCallId 
              })
              .eq('queue_id', lead.queue_id);
              
            pushLog(`[Dispatcher STAGE] queue-update queue_id=${lead.queue_id} status=dispatched`);
              console.log(`[Dispatcher] Successfully dispatched lead ${lead.active_lead_id}`);

          } catch (dialError) {
            pushLog(`[Dispatcher STAGE] placeCall-error queue_id=${lead.queue_id} error=${dialError?.message || dialError}`);
            console.error(`[Dispatcher STAGE] Dialing failed for ${lead.queue_id}: ${dialError?.message || dialError} | Stack: ${dialError?.stack?.substring(0, 500)}`);
            
            // Release slot immediately if dial failed
            await supabase.rpc('fn_release_slot', { p_call_id: currentSlotId });
            await supabase
              .from('call_queue')
              .update({ status: 'failed' })
              .eq('queue_id', lead.queue_id);
            
            // Also update the legacy lead status so UI reflects the failure
            if (lead.active_leads && lead.active_leads.lead_id) {
              await db.updateLeadStatusAndData(
                lead.active_leads.lead_id, 
                'failed', 
                lead.active_leads.leads?.raw_data || {}
              ).catch(e => console.warn('Failed to update lead status to failed:', e));
            }
          }
        } else {
           // E.g., 'global_limit_reached' or 'agent_limit_reached'
           const denyReason = (slotRes && slotRes.length > 0) ? slotRes[0]?.reason : 'unknown';
           console.log(`[Dispatcher] Slot reservation denied for ${lead.queue_id}: ${denyReason}`);
        }
        
        // Add slight delay between dispatches (pacing)
        const pacingDelay = parseInt(process.env.DIALER_PACING_DELAY_MS) || 1000;
        await new Promise(resolve => setTimeout(resolve, pacingDelay));
      }

    } finally {
      // 4. Release the lease
      await supabase.rpc('fn_dispatch_release', { p_run_id: this.runId });
    }
  }

  async placeCall(leadData, provisionalCallId) {
    // Extract the full lead record we joined from the DB
    const fullLead = leadData.active_leads?.leads;
    if (!fullLead) {
      throw new Error(`Could not find full lead record for active_lead_id: ${leadData.active_lead_id}`);
    }

    // Inject attempt_number and queue_id into raw_data so they flow through
    fullLead.raw_data = {
      ...(fullLead.raw_data || {}),
      attempt_number: leadData.attempt_number,
      queue_id: leadData.queue_id,
      provisional_call_id: provisionalCallId
    };

    console.log(`[Dispatcher] Dispatching live call to agent ${leadData.campaigns.voice_agent_id} at ${leadData.phone}`);

    // 1. Fetch onboarding config for tenant (needed by initSession)
    const onboardingConfig = await db.getOnboardingConfig(leadData.tenant_id);

    // Hard calling hours assertion: strictly prohibit initiating calls outside legal hours
    if (!isCallable(fullLead, onboardingConfig)) {
      throw new Error(`[Dispatcher] Refusing to dial lead ${fullLead.id} outside legal calling hours (09:00-21:00 IST, Mon-Sat).`);
    }

    // 2. Init Session with voice provider
    const providerType = leadData.campaigns?.voice_provider || process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
    const provider = await voiceProviderFactory.getProvider(fullLead.tenant_id, providerType);
    console.log(`[Dispatcher] Routing lead ${fullLead.id} via provider=${providerType}`);

    // Provider calls this URL back with call results: POST /leads/webhook/<provider>
    const webhookPath = `/leads/webhook/${encodeURIComponent(providerType)}?tenant_id=${encodeURIComponent(fullLead.tenant_id)}`;
    const appUrl = (
      process.env.PUBLIC_APP_URL ||
      `http://localhost:${process.env.PORT || 3000}`
    ).replace(/\/+$/, '');
    const webhookUrl = `${appUrl}${webhookPath}`;

    // Inject campaign-level voice_agent_id into the scriptContext so providers that
    // read scriptContext?.voice_agent_id can resolve the agent.
    const scriptContext = {
      ...onboardingConfig,
      voice_agent_id: leadData.campaigns?.voice_agent_id || null
    };
    const result = await provider.initSession(fullLead, scriptContext, webhookUrl);

    if (!result || !result.provider_session_id) {
       throw new Error(`Voice provider (${providerType}) initialization failed to return a session ID for lead ${fullLead.id}`);
    }

    // 3. Start heartbeat to hold the slot active
    // provider already loaded above
    provider.startHeartbeat(result.provider_session_id);

    return {
      success: true,
      callId: result.provider_session_id,
      interaction_id: result.interaction_id || null
    };
  }
}

export default new DispatcherWorker();
