import db from '../config/db.js';
import voiceProviderFactory from './voiceProvider/index.js';
import { sendSlackNotification } from './slackService.js';
import { connectedDispositions } from "../utils/constants.js";
import { dispatchWebhook } from './webhookService.js';
import { computeDynamicScore, computeOutcomeScore } from './scoringEngine.js';
import { analyzeTranscript } from './llmService.js';
import { tenantConfigService } from './tenantConfigService.js';

let workerInterval = null;
let isProcessing = false;

/**
 * Enforces Indian Standard Time (IST) calling hours (9 AM - 9 PM, per TRAI telemarketing norms) and Mon–Sat allowed calling days.
 * Default window: 09:00–21:00 IST (configurable via calling_hours in onboarding config).
 * Bypass only for: explicit BYPASS_CALLING_HOURS=true env var, per-config flag, or test runner.
 * @param {object} lead The lead object.
 * @param {object} config Onboarding/tenant config.
 * @returns {boolean} True if within calling hours, false otherwise.
 */
export function isCallable(lead, config = {}, checkDate = null) {
  // Allow test runner bypass unless enforce_calling_hours is explicitly true
  if (!config.enforce_calling_hours) {
    if (process.env.BYPASS_CALLING_HOURS === 'true' || config.bypass_calling_hours === true || process.env.NODE_ENV === 'test') {
      return true;
    }
  }

  const startHour = config.calling_hours?.start ?? 9;
  const endHour = config.calling_hours?.end ?? 21; // TRAI: 09:00–21:00 IST (not 18:00)
  const timezone = config.calling_hours?.timezone || 'Asia/Kolkata';

  const now = checkDate ? (checkDate instanceof Date ? checkDate : new Date(checkDate)) : new Date();
  
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
      hourCycle: 'h23',
      weekday: 'short'
    });
    const parts = formatter.formatToParts(now);
    const hourPart = parts.find(p => p.type === 'hour');
    const weekdayPart = parts.find(p => p.type === 'weekday');

    const currentHour = hourPart ? parseInt(hourPart.value, 10) : now.getHours();
    const currentDay = weekdayPart ? weekdayPart.value : '';

    if (currentDay === 'Sun') {
      return false; // No Sundays
    }

    return currentHour >= startHour && currentHour < endHour;
  } catch (err) {
    const day = now.getDay();
    const hour = now.getHours();
    if (day === 0) return false;
    return hour >= startHour && hour < endHour;
  }
}

/**
 * Returns the earliest ISO timestamp at which a call may legally be placed,
 * respecting TRAI calling hours (09:00–21:00 IST, Mon–Sat by default).
 *
 * - Within calling hours on a weekday → returns NOW (call immediately)
 * - Before start hour today           → returns today at startHour in the configured timezone
 * - After end hour today              → returns tomorrow at startHour
 * - Sunday                            → returns Monday at startHour
 *
 * @param {object} [config] Optional onboarding config containing calling_hours overrides.
 * @param {Date|string} [fromDate] Optional base reference date/time.
 * @returns {string} ISO 8601 UTC timestamp
 */
export function nextCallableSlot(config = {}, fromDate = null) {
  // Allow bypass in test / dev environments unless explicitly enforcing calling hours
  if (!config.enforce_calling_hours) {
    if (
      process.env.BYPASS_CALLING_HOURS === 'true' ||
      config.bypass_calling_hours === true ||
      process.env.NODE_ENV === 'test'
    ) {
      return new Date().toISOString();
    }
  }

  const startHour = config.calling_hours?.start ?? 9;
  const endHour   = config.calling_hours?.end   ?? 21;
  const timezone  = config.calling_hours?.timezone || 'Asia/Kolkata';

  const now = fromDate ? (fromDate instanceof Date ? fromDate : new Date(fromDate)) : new Date();

  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
      hourCycle: 'h23',
      weekday: 'short'
    });
    const parts = fmt.formatToParts(now);
    const currentHour = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const currentDay  = parts.find(p => p.type === 'weekday').value; // e.g. 'Mon'
    const isSunday    = currentDay === 'Sun';
    const withinHours = currentHour >= startHour && currentHour < endHour;

    // Happy path — inside the calling window on a valid weekday
    if (!isSunday && withinHours) {
      return now.toISOString();
    }

    // Decide which calendar date to schedule on
    const candidate = new Date(now);
    if (currentHour >= endHour) {
      // Past the end of today's window — move to next calendar day
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    // (Before start hour stays on same day; Sunday also starts on same day then skips below)

    // Skip over any Sundays
    const dayFmt = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' });
    for (let i = 0; i < 7; i++) {
      if (dayFmt.format(candidate) !== 'Sun') break;
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }

    // Get the YYYY-MM-DD date string in the target timezone
    const dateStr = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(candidate); // e.g. '2026-09-08'

    // Build the ISO string with the explicit IST offset so Date parses it correctly
    const tzOffset = timezone === 'Asia/Kolkata' ? '+05:30' : '+05:30';
    const targetIso = `${dateStr}T${String(startHour).padStart(2, '0')}:00:00${tzOffset}`;
    return new Date(targetIso).toISOString();
  } catch (err) {
    // Fallback: schedule 1 minute ahead so the dispatcher at least sees the row
    console.warn('[QueueService] nextCallableSlot fallback triggered:', err.message);
    return new Date(Date.now() + 60 * 1000).toISOString();
  }
}

/**
 * Calculates the legal next retry ISO timestamp, ensuring that retries are NEVER
 * scheduled outside permitted calling hours (09:00–21:00 IST, Mon–Sat).
 * If the calculated backoff falls outside calling hours, it automatically rolls forward
 * to the next legal calling slot (e.g. 09:00 AM the next morning or Monday).
 */
export function calculateNextRetrySlot(attempts, retryGaps = [15 * 60 * 1000, 120 * 60 * 1000, 24 * 60 * 60 * 1000], config = {}) {
  const gap = retryGaps[attempts - 1] || retryGaps[retryGaps.length - 1] || (15 * 60 * 1000);
  const targetDate = new Date(Date.now() + gap);

  // If outside calling hours or on Sunday, snap to next callable slot
  if (!isCallable({}, config, targetDate)) {
    return nextCallableSlot(config, targetDate);
  }

  return targetDate.toISOString();
}


/**
 * Enqueues a lead by updating its status to 'queued' and starting the worker if not active.
 */
export async function enqueueLead(leadId, priority) {
  const lead = await db.findLeadById(leadId);
  if (!lead) return null;
  
  if (lead.status === 'dnc' || lead.status === 'closed' || lead.status === 'converted') {
    return lead; // Terminal state, ignore
  }

  // Calculate exponential backoff for retries
  let nextRetryAt = null;
  const attempts = lead.raw_data?.attempts || 0;
  
  if (lead.status === 're-queued') {
    const delayMinutes = Math.pow(3, attempts) * 5; // 5, 15, 45, 135 minutes...
    const backoffMs = Math.min(delayMinutes * 60 * 1000, 24 * 60 * 60 * 1000); // Max 24 hours
    nextRetryAt = new Date(Date.now() + backoffMs).toISOString();
  }

  // Preserve existing raw_data and append retry metrics
  const rawData = lead.raw_data || {};
  rawData.attempts = attempts + 1;
  if (nextRetryAt) rawData.next_retry_at = nextRetryAt;

  let finalStatus = 'queued';
  const tConfig = await tenantConfigService.getTenantConfig(lead.tenant_id);
  // Hook: add your own lead segmentation / channel routing here if needed
  // (e.g. set finalStatus or rawData.maxVoiceAttempts from tConfig).
  void tConfig;

  // Use the proper abstraction which handles both Supabase and mock mode
  await db.updateLeadStatusAndData(leadId, finalStatus, rawData);

  const updated = await db.findLeadById(leadId);
  
  // Log enqueued audit event
  await db.insertAuditLog(lead.tenant_id, 'lead_enqueued', {
    lead_id: leadId,
    phone: lead.phone,
    score: lead.score
  });

  // Push to Postgres AI Dialer State Machine if it's a voice lead
  if (finalStatus === 'queued' || finalStatus === 're-queued') {
    try {
      // Compute earliest legal call time so the dispatcher's next_attempt_at filter
      // always returns this row (NULL rows are invisible to the dispatcher query).
      const onboardingCfg = await db.getOnboardingConfig(lead.tenant_id).catch(() => ({}));
      const scheduledAt = nextCallableSlot(onboardingCfg);
      await db.enqueueToDialer(lead.tenant_id, leadId, lead.phone, lead.campaign_name, scheduledAt, 1);
      console.log(`[QueueService] Lead ${leadId} pushed to Postgres dialer queue. Scheduled at ${scheduledAt}.`);
    } catch (err) {
      console.error(`[QueueService] Failed to push lead ${leadId} to Postgres dialer:`, err);
    }
  }

  return updated;
}

async function resetStaleCalls() {
  try {
    const callingLeads = await db.getAllLeadsByStatus(['calling']);
    const STALE_THRESHOLD = 15 * 60 * 1000; // 15 minutes (real calls can take 5-10+ min)
    let staleCount = 0;
    for (const lead of callingLeads) {
      if (Date.now() - new Date(lead.updated_at || lead.created_at || Date.now()).getTime() > STALE_THRESHOLD) {
        await db.updateLeadStatus(lead.id, 'failed');
        staleCount++;
      }
    }
    if (staleCount > 0) {
      console.log(`[QueueWorker] Reset ${staleCount} stale calls to failed status to free up concurrency limits.`);
    }
  } catch (e) {
    console.error('[QueueWorker] Error resetting stale calls:', e);
  }
}

/**
 * Processes queued and re-queued leads, checking priority, calling hours, DNC, and concurrency.
 */
export async function processQueue() {
  console.log(`[QueueWorker] Old Node.js processQueue() was invoked, but is DISABLED. The Postgres-driven dispatcher handles this now.`);
  return;
}

/**
 * Extracts consent status from structured outputs, transcript, or summary per specification:
 * 1. structuredOutputs.consent_status (if agent's structured output declares it — preferred)
 * 2. Regex on summary/transcript for Hindi/English affirmatives near the offer-confirmation moment ("हां", "haan", "yes", "link भेज दो", "send the link") -> agreed
 * 3. Denials ("नहीं", "no", "not interested", "बाद में", "later") -> declined
 * 4. Otherwise -> unclear
 */
export function extractConsentStatus({ structuredOutputs, summary, transcript, isFailure, analysis }) {
  if (isFailure) {
    return 'not_asked';
  }

  // Priority 1: structuredOutputs.consent_status
  const explicitConsent = structuredOutputs?.consent_status || structuredOutputs?.consent;
  if (explicitConsent) {
    const norm = String(explicitConsent).toLowerCase().trim();
    if (['agreed', 'agree', 'yes', 'accepted'].includes(norm)) return 'agreed';
    if (['declined', 'decline', 'no', 'rejected'].includes(norm)) return 'declined';
    if (['unclear', 'not_asked'].includes(norm)) return norm;
  }

  // Priority 1.5: LLM-classified consent (from analyzeTranscript output)
  const llmConsent = analysis?.consent_status;
  if (llmConsent) {
    const normLlm = String(llmConsent).toLowerCase().trim();
    if (['agreed','declined','unclear','not_asked'].includes(normLlm)) {
      return normLlm;
    }
    return 'unclear';
  }

  // Combine summary and transcript text
  let text = '';
  if (typeof summary === 'string') text += ' ' + summary;
  else if (typeof summary === 'object' && summary !== null) text += ' ' + JSON.stringify(summary);

  if (typeof transcript === 'string') {
    text += ' ' + transcript;
  } else if (Array.isArray(transcript)) {
    text += ' ' + transcript.map(t => typeof t === 'string' ? t : (t.message || t.text || '')).join(' ');
  } else if (transcript && typeof transcript === 'object') {
    const msgs = Array.isArray(transcript.messages) ? transcript.messages
              : Array.isArray(transcript.transcript_data?.messages) ? transcript.transcript_data.messages
              : Array.isArray(transcript.turns) ? transcript.turns
              : [];
    text += ' ' + msgs.map(m => m.message || m.text || m.content || '').join(' ');
  }

  // Strip system fallback placeholders to prevent false denial triggers
  text = text.replace(/no\s+transcript(?:\s+generated|\s+available)?/gi, '');
  text = text.replace(/simulated\s+call/gi, '');

  if (!text.trim()) {
    return 'not_asked';
  }

  // Priority 2: Affirmatives
  // ("हां", "haan", "yes", "link भेज दो", "send the link") -> agreed
  const affirmativeRegex = /(?:हां|link\s*भेज\s*दो|\bhaan\b|\byes\b|send\s*(?:the\s*)?link)/i;

  // Priority 3: Denials
  // ("नहीं", "no", "not interested", "बाद में", "later") -> declined
  const denialRegex = /(?:नहीं|बाद\s*में|\bno\b|\bnot\s*interested\b|\blater\b)/i;

  if (affirmativeRegex.test(text)) {
    return 'agreed';
  }

  if (denialRegex.test(text)) {
    return 'declined';
  }

  // Priority 4: Otherwise
  return 'unclear';
}

/**
 * Handles the call outcome when a call ends (from webhook or mock end events).
 * Manages retry schedules, exponential backoff, and terminal status transitions.
 */
export async function handleCallOutcome(providerSessionId, disposition, duration = 0, summary = '', transcript_json = null, sentiment = '', recordingUrl = null, structuredOutputs = null) {
  const session = await db.findCallSessionByProviderId(providerSessionId);

  if (!session) {
    console.warn(`[handleCallOutcome] Session ${providerSessionId} not found, aborting`);
    return;
  }
  // Atomic single-flight guard — only one invocation wins
  if (db.supabase) {
    const { data: claimed, error: claimErr } = await db.supabase
      .from('call_sessions')
      .update({ ended_at: new Date().toISOString() })
      .eq('id', session.id)
      .is('ended_at', null)
      .select('id');

    if (claimErr) {
      console.error('[handleCallOutcome] Claim failed:', claimErr);
      return;
    }
    if (!claimed || claimed.length === 0) {
      console.log(`[handleCallOutcome] Skipped duplicate invocation for session ${session.id}`);
      return;
    }
  } else {
    const isTerminal = session.disposition && ['completed', 'failed', 'no_answer', 'user_busy', 'qualified', 'not_interested', 'dnc', 'won'].includes(session.disposition.toLowerCase());
    if (session.ended_at || isTerminal) {
      console.log(`[handleCallOutcome] Skipped duplicate invocation for session ${session.id}`);
      return;
    }
    session.ended_at = new Date().toISOString();
  }

  // Unconditionally release the slot. Determine the correct provider type from the
  // campaign (via active_leads → campaigns) rather than hardcoding a provider.
  // Fall back to DEFAULT_VOICE_PROVIDER so the heartbeat is always cleared.
  let releaseProviderType = process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
  if (session?.tenant_id && db.supabase) {
    try {
      const { data: alRow } = await db.supabase
        .from('active_leads')
        .select('campaign_id')
        .eq('lead_id', session.lead_id)
        .maybeSingle();
      if (alRow?.campaign_id) {
        const { data: camp } = await db.supabase
          .from('campaigns')
          .select('voice_provider')
          .eq('id', alRow.campaign_id)
          .maybeSingle();
        if (camp?.voice_provider) releaseProviderType = camp.voice_provider;
      }
    } catch (_) { /* non-fatal — fall back to default provider */ }
  }
  const provider = await voiceProviderFactory.getProvider(session?.tenant_id || null, releaseProviderType);
  if (typeof provider.releaseSlot === 'function') {
    await provider.releaseSlot(providerSessionId);
  }

  // Release the concurrency slot in Postgres immediately so other queued calls can dial
  if (db.supabase && providerSessionId) {
    try {
      await db.supabase.rpc('fn_release_slot', { p_call_id: providerSessionId });
    } catch (slotErr) {
      console.warn('[QueueService] Failed to release Postgres concurrency slot via RPC:', slotErr?.message || slotErr);
    }
  }

  if (!session) return;

  const lead = await db.findLeadById(session.lead_id);
  if (!lead) return;

  const onboardingConfig = await db.getOnboardingConfig(session.tenant_id);

  // If this is a real provider call (not mock/simulated), ask the provider for the final
  // transcript / summary / recording. Implement fetchArtifacts() in your provider adapter.
  const isSimulated = !providerSessionId || providerSessionId.startsWith('mock-') || providerSessionId.startsWith('sim-');
  const failureDispositionsForFetch = ['no_answer', 'busy', 'failed', 'busy-signal', 'no-answer', 'voicemail', 'user_busy', 'rejected', 'canceled', 'unavailable'];

  if (!isSimulated && !failureDispositionsForFetch.includes(disposition.toLowerCase()) && typeof provider.fetchArtifacts === 'function') {
    try {
      const artifacts = await provider.fetchArtifacts(providerSessionId);
      if (artifacts) {
        const t = artifacts.transcript || artifacts.transcript_json;
        if (t) transcript_json = t;
        summary = artifacts.summary || summary;
        sentiment = artifacts.sentiment || sentiment;
        if (artifacts.duration_seconds || artifacts.duration) duration = artifacts.duration_seconds || artifacts.duration;
        if (artifacts.recording_url) recordingUrl = artifacts.recording_url;
      }
    } catch (apiErr) {
      // NotImplementedError from base.js lands here too — that's fine.
      console.warn('[QueueWorker] Provider fetchArtifacts skipped/failed (non-fatal):', apiErr.message);
    }
  }

  // Fallback: If transcript is missing, try reconstructing from recorded session events
  const failureDispositions = ['no_answer', 'busy', 'failed', 'busy-signal', 'no-answer', 'voicemail', 'user_busy', 'rejected', 'canceled', 'unavailable'];
  const isFailure = failureDispositions.includes(disposition.toLowerCase());

  // Merge provider structured_outputs into analysis context if provided
  // (fields the voice provider's own AI already extracted: callback dates, sentiment, etc.).
  const providerEnrichment = (structuredOutputs && typeof structuredOutputs === 'object') ? structuredOutputs : {};

  if (!transcript_json && !isFailure) {
    try {
      const events = await db.getCallEvents(session.tenant_id);
      const sessionEvents = events.filter(e => e.session_id === session.id || (e.payload && e.payload.lead_id === lead.id));
      const speechEvents = sessionEvents.filter(e => e.payload && (e.payload.transcript || e.payload.message));
      if (speechEvents.length > 0) {
        transcript_json = speechEvents.map(se => ({
          speaker: se.payload?.speaker || (se.event_type.includes('user') || se.event_type.includes('intent') ? 'Customer' : 'Agent'),
          role: (se.event_type.includes('user') || se.event_type.includes('intent')) ? 'user' : 'assistant',
          message: se.payload?.transcript || se.payload?.message || '',
          timestamp: se.timestamp || new Date().toISOString()
        }));
      }
    } catch (e) {
      console.warn('[QueueWorker] Could not reconstruct transcript from call_events:', e.message);
    }
  }

  // If duration is 0, estimate from start/end timestamps or speech turns
  if ((!duration || duration === 0) && session.started_at) {
    const startMs = new Date(session.started_at).getTime();
    const endMs = Date.now();
    const elapsed = Math.round((endMs - startMs) / 1000);
    if (elapsed > 0 && elapsed < 3600) duration = elapsed;
  }
  if ((!duration || duration === 0) && Array.isArray(transcript_json) && transcript_json.length > 0) {
    duration = Math.min(300, transcript_json.length * 7);
  }

  // Analyze transcript using the LLM service
  let parsedSummary = summary;
  let parsedSentiment = sentiment;
  let parsedAnalysis = null;
  
  if (transcript_json || disposition) {
    try {
      const llmResult = await analyzeTranscript(transcript_json, disposition, lead);
      if (llmResult.success) {
        parsedSummary = llmResult.summary || parsedSummary;
        parsedSentiment = llmResult.sentiment || parsedSentiment;
        parsedAnalysis = llmResult.analysis || {
          summary: llmResult.summary,
          reasoning: llmResult.reasoning,
          lead_classification: llmResult.lead_classification,
          lead_score: llmResult.lead_score,
          motivation: llmResult.motivation,
          product_type: llmResult.product_type,
          retry_required: llmResult.retry_required,
          dnd: llmResult.dnd,
          consent_status: llmResult.consent_status,
          consent_reasoning: llmResult.consent_reasoning
        };
        // Ensure lead_score, reasoning and classification are directly accessible
        if (llmResult.lead_score !== undefined && parsedAnalysis.lead_score === undefined) parsedAnalysis.lead_score = llmResult.lead_score;
        if (llmResult.reasoning && !parsedAnalysis.reasoning) parsedAnalysis.reasoning = llmResult.reasoning;
        if (llmResult.lead_classification && !parsedAnalysis.lead_classification) parsedAnalysis.lead_classification = llmResult.lead_classification;
      }
    } catch (llmErr) {
      console.error('[QueueWorker] Error running LLM transcript analysis:', llmErr);
    }
  }

  // Merge provider structured_outputs into parsedAnalysis so the scoring engine sees
  // PTP fields, pre-mapped classifications, sentiment, DND flags etc.
  // Disposition-mapper-provided classification takes priority over LLM when present.
  if (!isFailure && Object.keys(providerEnrichment).length > 0) {
    parsedAnalysis = {
      ...(parsedAnalysis || {}),
      ...providerEnrichment,
      // Pre-mapped classification from the provider takes priority over LLM
      lead_classification: providerEnrichment.lead_classification ||
        parsedAnalysis?.lead_classification || null,
      // Override DND if the provider explicitly flagged it
      dnd: providerEnrichment.dnd || parsedAnalysis?.dnd || false,
      // Merge PTP signals
      ptp_amount:   providerEnrichment.ptp_amount   || parsedAnalysis?.ptp_amount   || null,
      ptp_date:     providerEnrichment.ptp_date     || parsedAnalysis?.ptp_date     || null,
      callback_time: providerEnrichment.callback_time || parsedAnalysis?.callback_time || null,
    };
    // Reflect provider sentiment if stronger than LLM sentiment
    if (providerEnrichment.provider_sentiment) {
      parsedSentiment = parsedSentiment && parsedSentiment !== 'NEUTRAL'
        ? parsedSentiment
        : providerEnrichment.provider_sentiment;
    }
  }

  // AI Hallucination Fix: Force clear hallucinated metadata if the call never connected
  if (isFailure) {
    parsedSummary = '{"call_purpose": "Call did not connect / was not picked up."}';
    parsedSentiment = 'NEUTRAL';
    // Preserve transcript_json and recording_url on failure — partial evidence may exist.
    parsedAnalysis = {
      call_outcome: "Call failed/unanswered",
      engagement_level: "LOW",
      store_visit_scheduled: false,
      store_visit_date: "No plans"
    };
  }

  // Extract customer consent per Task 4
  const consentStatus = extractConsentStatus({
    structuredOutputs: providerEnrichment,
    summary: parsedSummary,
    transcript: transcript_json || session.transcript_json,
    isFailure,
    analysis: parsedAnalysis
  });
  const consentCapturedAt = new Date().toISOString();

  const appUrl = (
    process.env.PUBLIC_APP_URL ||
    `http://localhost:${process.env.PORT || 3000}`
  ).replace(/\/+$/, '');

  const effectiveRecordingUrl = recordingUrl || session.recording_url || null;
  const playableRecordingUrl = (effectiveRecordingUrl && process.env.PROXY_RECORDING_HOSTS && process.env.PROXY_RECORDING_HOSTS.split(',').some(h => h.trim() && effectiveRecordingUrl.includes(h.trim())) && session?.id)
    ? `${appUrl}/leads/recordings/${session.id}/audio`
    : effectiveRecordingUrl;

  // Update session record with full duration, transcript, audio URL, and consent
  await db.updateCallSession(session.id, {
    disposition,
    summary: parsedSummary,
    duration: duration || session.duration || 0,
    transcript_json: transcript_json || session.transcript_json || null,
    sentiment: parsedSentiment || session.sentiment || null,
    analysis: parsedAnalysis || session.analysis || null,
    recording_url: playableRecordingUrl || effectiveRecordingUrl || null,
    consent_status: consentStatus,
    consent_captured_at: consentCapturedAt
  });

  session.consent_status = consentStatus;
  session.consent_captured_at = consentCapturedAt;
  session.recording_url = playableRecordingUrl || session.recording_url;


  // Hook: post-call callback to a client system goes here (use webhookService.dispatchWebhook
  // for generic outgoing webhooks — see the call_completed dispatch further below).

  // NEW: Insert into call_logs to trigger Postgres retry state machine & sync call_queue
  if (db.supabase) {
      try {
          const { data: activeLeadRows } = await db.supabase.from('active_leads')
            .select('active_lead_id')
            .eq('lead_id', lead.id)
            .order('created_at', { ascending: false })
            .limit(1);
            
          const activeLeadId = activeLeadRows && activeLeadRows.length > 0 ? activeLeadRows[0].active_lead_id : null;

          if (activeLeadId) {
             const retryReq = parsedAnalysis?.retry_required !== undefined ? parsedAnalysis.retry_required : isFailure;
             await db.supabase.from('call_logs').upsert({
                 tenant_id: session.tenant_id,
                 active_lead_id: activeLeadId,
                 call_id: providerSessionId,
                 phone: lead.phone,
                 status: disposition,
                 duration_seconds: duration || 0,
                 transcript: transcript_json || {},
                 qa_extracted: true,
                 lead_classification: parsedAnalysis?.lead_classification || (isFailure ? null : 'UNKNOWN'),
                 retry_required: retryReq,
                 dnd: parsedAnalysis?.dnd || false,
                 purchase_timeline: parsedAnalysis?.purchase_timeline || false
             }, { onConflict: 'call_id' });
          }

          // Direct safety update on call_queue to mark attempt completed/failed
          await db.supabase
            .from('call_queue')
            .update({ 
              status: isFailure ? 'failed' : 'completed',
              updated_at: new Date().toISOString()
            })
            .or(`provisional_call_id.eq.${providerSessionId}${activeLeadId ? `,active_lead_id.eq.${activeLeadId}` : ''}`);
      } catch (err) {
          console.error('[QueueWorker] Failed to insert call_logs or update call_queue for Postgres trigger:', err);
      }
  }

  let outcomeScore = lead.score || 30;

  if (isFailure) {
    // No outcome — preserve pre-call priority, leave session.outcome_score NULL
  } else {
    // NEW: Outcome scoring replaces dynamic scoring. Overwrite leads.score with post-call outcome
    // and store on the session.
    outcomeScore = computeOutcomeScore(
      parsedAnalysis?.lead_classification,
      parsedAnalysis,
      transcript_json || session.transcript_json,
      duration || session.call_duration_seconds || 0,
      disposition,
      lead
    );

    // Write to call_sessions
    await db.updateCallSession(session.id, { outcome_score: outcomeScore });

    // Overwrite lead score
    await db.updateLeadScore(lead.id, outcomeScore);
  }

  if (isFailure) {
    let currentCampaignId = null;
    if (lead?.campaign_name) {
      const campaigns = await db.getCampaigns(lead.tenant_id);
      const camp = campaigns.find(c => c.name === lead.campaign_name);
      currentCampaignId = camp?.id;
    }
    const attempts = await db.getCallSessionsCount(lead.id, currentCampaignId);
    let maxAttempts = onboardingConfig.max_attempts || 3;
    
    // Per-lead override of max attempts (set by your own segmentation hook)
    if (lead.raw_data?.maxVoiceAttempts !== undefined) {
        maxAttempts = lead.raw_data.maxVoiceAttempts;
    }

    const retryGaps = process.env.NODE_ENV === 'test' 
      ? [1000, 2000, 3000] // Short gaps for test runner
      : (onboardingConfig.retry_gaps || [15 * 60 * 1000, 120 * 60 * 1000, 24 * 60 * 60 * 1000]); // 15m, 2h, 24h

    if (attempts < maxAttempts) {
      // Re-queue the lead with a calculated delay (gap backoff), strictly respecting legal calling hours
      const nextRetryAt = calculateNextRetrySlot(attempts, retryGaps, onboardingConfig);

      const updatedRaw = {
        ...(lead.raw_data || {}),
        last_call_at: new Date().toISOString(),
        call_duration_seconds: duration || 0,
        recording_url: recordingUrl || session.recording_url || null,
        next_retry_at: nextRetryAt,
        attempts,
        transcript_json,
        sentiment: parsedSentiment,
        analysis: parsedAnalysis,
        initial_score: (lead.raw_data?.initial_score ?? lead.score ?? 30),
        after_call_score: (lead.score || 30),
        last_disposition: disposition,
        reasoning: parsedAnalysis?.reasoning || null
      };

      await db.updateLeadStatusAndData(lead.id, 're-queued', updatedRaw);
      // Pass nextRetryAt so the dispatcher's next_attempt_at filter picks it up at the right time
      await db.enqueueToDialer(lead.tenant_id, lead.id, lead.phone, lead.campaign_name, nextRetryAt, attempts + 1);

      await db.insertAuditLog(session.tenant_id, 'call_retry_scheduled', {
        lead_id: lead.id,
        phone: lead.phone,
        attempt: attempts,
        next_retry_at: nextRetryAt
      });

      const campName = lead.campaign_name || session.campaign_name || 'Campaign';
      const retrySlackMsg = [
        `🔄 *[Call Incomplete / No Answer]*`,
        `• *Campaign:* ${campName}`,
        `• *Customer:* ${lead.name || 'Unknown'} (${lead.phone || 'Unknown'})`,
        `• *Disposition:* ${disposition} | *Duration:* ${duration || 0}s`,
        `• *Attempt:* ${attempts}/${maxAttempts}`,
        nextRetryAt ? `• *Next Retry:* ${new Date(nextRetryAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST` : null
      ].filter(Boolean).join('\n');
      try {
        await sendSlackNotification(retrySlackMsg);
      } catch (e) {
        console.warn('[QueueWorker] Slack notify failed for incomplete call:', e.message);
      }
    } else {
      // Max attempts reached, mark as closed
      const updatedRaw = {
        ...(lead.raw_data || {}),
        last_call_at: new Date().toISOString(),
        call_duration_seconds: duration || 0,
        recording_url: recordingUrl || session.recording_url || null,
        transcript_json,
        sentiment: parsedSentiment,
        analysis: parsedAnalysis,
        initial_score: (lead.raw_data?.initial_score ?? lead.score ?? 30),
        after_call_score: (lead.score || 30),
        last_disposition: disposition,
        reasoning: parsedAnalysis?.reasoning || null
      };
      
      await db.updateLeadStatusAndData(lead.id, 'closed', updatedRaw);
      await db.insertAuditLog(session.tenant_id, 'call_failed_max_attempts', {
        lead_id: lead.id,
        phone: lead.phone,
        attempts
      });
      const phoneDisplay = lead.phone || 'Unknown';
      const campName = lead.campaign_name || session.campaign_name || 'Campaign';
      const closedSlackMsg = [
        `❌ *[Call Finalized - Max Retries Reached]*`,
        `• *Campaign:* ${campName}`,
        `• *Customer:* ${lead.name || 'Unknown'} (${phoneDisplay})`,
        `• *Disposition:* ${disposition} | *Duration:* ${duration || 0}s`,
        `• *Total Attempts Made:* ${maxAttempts}`,
        `• *Status:* Marked CLOSED_LOST`
      ].join('\n');
      try {
        await sendSlackNotification(closedSlackMsg);
      } catch (e) {
        console.warn('[QueueWorker] Slack notify failed for closed call:', e.message);
      }
    }
  } else {
    // Successful or other terminal disposition (e.g. qualified)
    const finalStatus = disposition.includes('escalated') ? 'hot_escalated' : 'called';

    if (lead.status === 'failed' || lead.status === 'closed') {
        console.warn(`[QueueService] Reversing false-fail for session ${session.id} — late webhook arrived with success disposition '${disposition}'`);
        try {
            await db.updateLeadStatusAndData(lead.id, finalStatus, { ...(lead.raw_data || {}), next_retry_at: null, last_dial_error: null });
            if (db.supabase) {
                const { data: alRows } = await db.supabase
                  .from('active_leads')
                  .select('active_lead_id')
                  .eq('lead_id', lead.id);
                if (alRows && alRows.length > 0) {
                  const alIds = alRows.map(r => r.active_lead_id);
                  await db.supabase.from('call_queue').update({ status: 'completed' }).in('active_lead_id', alIds);
                }
            }
            if (lead.raw_data) {
                lead.raw_data.next_retry_at = null;
                lead.raw_data.last_dial_error = null;
            }
        } catch (undoErr) {
            console.error(`[QueueService] Failed to reverse false-fail:`, undoErr.message);
        }
    }
      const updatedRaw = {
        ...(lead.raw_data || {}),
        last_call_at: new Date().toISOString(),
        call_duration_seconds: duration || 0,
        transcript_json,
        recording_url: playableRecordingUrl || recordingUrl || session.recording_url || null,
        sentiment: parsedSentiment,
        analysis: parsedAnalysis,
        // Persist pre-call and post-call scores so frontend dual-ring always has data
        initial_score: (lead.score || 30),
        after_call_score: outcomeScore,
        lead_classification: parsedAnalysis?.lead_classification || null,
        reasoning: parsedAnalysis?.reasoning || null
      };
      await db.updateLeadStatusAndData(lead.id, finalStatus, updatedRaw);

      // Generate/Update Agent Brief with latest call outcomes and insights
      try {
        let keyPhrases = [];
        let objections = [];
        if (Array.isArray(transcript_json)) {
          transcript_json.forEach(msg => {
            const text = msg.message || msg.content || msg.text;
            if (text && text.length > 5 && !keyPhrases.includes(text)) {
              keyPhrases.push(text);
            }
          });
        }
        if (keyPhrases.length === 0) {
          if (lead.product_type) keyPhrases.push(`Product: ${lead.product_type}`);
          if (lead.business_type) keyPhrases.push(`Segment: ${lead.business_type}`);
          if (keyPhrases.length === 0) keyPhrases = ['Outbound call completed'];
        }

        let recommendedAction = 'Contact the lead immediately by phone.';
        if (finalStatus === 'hot_escalated' || outcomeScore >= 80) {
          recommendedAction = 'High-intent lead. Direct senior specialist outreach recommended immediately.';
        } else if (outcomeScore >= 60) {
          recommendedAction = 'Qualified prospect. Proceed with outbound product pitch and schedule site visit or demo.';
        } else if (outcomeScore >= 40) {
          recommendedAction = 'Warm lead. Share digital brochure and follow up via WhatsApp / voice touchpoint.';
        } else {
          recommendedAction = 'Cold lead. Enroll into automated re-engagement drip campaign.';
        }

        const briefData = {
          lead_name: lead.name || 'Anonymous Prospect',
          phone: lead.phone,
          score: outcomeScore,
          lead_score: outcomeScore,
          call_duration_seconds: duration || 0,
          call_summary: parsedSummary || summary || 'Call completed.',
          transcript_json: transcript_json || lead.raw_data?.transcript_json || null,
          recording_url: playableRecordingUrl || recordingUrl || session.recording_url || session.audio_url || null,
          sentiment: parsedSentiment || 'neutral',
        analysis: parsedAnalysis || {},
        key_phrases: keyPhrases.slice(0, 5),
        objections: objections,
        recommended_action: recommendedAction,
        escalation_reason: finalStatus === 'hot_escalated' ? 'High intent qualification' : (disposition || 'Standard Call Outcome'),
        timestamp: new Date().toISOString()
      };

      await db.upsertAgentBrief(session.tenant_id, lead.id, briefData);
    } catch (briefErr) {
      console.warn('[QueueWorker] Non-critical warning: failed to update agent brief on call outcome:', briefErr.message);
    }

    // Update campaign metrics if applicable
    if (lead.campaign_name && (finalStatus === 'called' || finalStatus === 'hot_escalated')) {
      try {
        const firstCamp = lead.campaign_name
          ? String(lead.campaign_name).split(',')[0].trim().toLowerCase()
          : null;
        const campaigns = await db.getCampaigns(session.tenant_id);
        const campaign = campaigns.find(c => 
          c.id === firstCamp || 
          (c.name && c.name.toLowerCase() === firstCamp)
        );
        if (campaign) {
          const currentConnected = campaign.connected || 0;
          await db.updateCampaign(campaign.id, { connected: currentConnected + 1 });
        }
      } catch (campErr) {
        console.warn('[QueueWorker] Non-critical warning: failed to increment campaign connected count:', campErr.message);
      }
    }
    
    // Dispatch webhook for Zapier / Google Sheets sync
    await dispatchWebhook(session.tenant_id, 'lead.scored', {
      client_id: lead.raw_data?.client_id || lead.id,
      phone: lead.phone,
      name: lead.name,
      ai_score: outcomeScore,
      status: finalStatus,
      summary: summary
    });

    const phoneDisplay = lead.phone ? lead.phone : 'unknown';
    const durSec = duration || session.call_duration_seconds || 0;
    const classification = parsedAnalysis?.lead_classification || (outcomeScore === 100 ? 'HOT' : outcomeScore >= 75 ? 'WARM' : outcomeScore <= 10 ? 'NOT_INTERESTED' : 'COLD');
    const consent = consentStatus || parsedAnalysis?.consent_status || 'not_asked';
    const campName = lead.campaign_name || session.campaign_name || 'Campaign';
    const scoreEmoji = outcomeScore === 100 ? '🔥' : outcomeScore >= 75 ? '⭐' : outcomeScore <= 10 ? '🚫' : '📊';

    let cleanSummaryText = parsedSummary || summary || parsedAnalysis?.summary || 'Call completed.';
    if (typeof cleanSummaryText === 'string') {
      try {
        const jsonParsed = JSON.parse(cleanSummaryText);
        cleanSummaryText = jsonParsed.summary || jsonParsed.call_purpose || jsonParsed.reasoning || cleanSummaryText;
      } catch (_) {}
    }
    if (typeof cleanSummaryText === 'object' && cleanSummaryText !== null) {
      cleanSummaryText = cleanSummaryText.summary || cleanSummaryText.call_purpose || cleanSummaryText.reasoning || JSON.stringify(cleanSummaryText);
    }
    if (typeof cleanSummaryText === 'string' && cleanSummaryText.length > 250) {
      cleanSummaryText = cleanSummaryText.substring(0, 247) + '...';
    }

    const finalAudioUrl = playableRecordingUrl || recordingUrl || session.recording_url;

    const callDetailMsg = [
      `📞 *[Call Completed]* ${scoreEmoji} Score: *${outcomeScore}/100* (${classification})`,
      `• *Campaign:* ${campName}`,
      `• *Customer:* ${lead.name || 'Unknown'} (${phoneDisplay})`,
      `• *Disposition:* ${disposition} | *Duration:* ${durSec}s`,
      `• *Consent:* ${consent.toUpperCase()}`,
      `• *AI Summary:* ${cleanSummaryText}`,
      finalAudioUrl ? `• *Audio Recording:* <${finalAudioUrl}|🎧 Listen to Call>` : null
    ].filter(Boolean).join('\n');

    try {
      await sendSlackNotification(callDetailMsg);
    } catch (slackErr) {
      console.warn('[QueueWorker] Failed to dispatch callDetail Slack notification:', slackErr.message);
    }
  }

  // Auto-check campaign completion to dispatch completion Slack alert immediately
  const campaignIdentifier = session.campaign_id || lead.raw_data?.campaign_id || lead.campaign_name;
  if (campaignIdentifier && db.supabase) {
    import('./campaignDialer.js').then(async m => {
      if (typeof m.checkAndNotifyCampaignCompletion === 'function') {
        let campId = session.campaign_id;
        if (!campId) {
          const camps = await db.getCampaigns(session.tenant_id);
          const c = camps.find(camp => camp.id === campaignIdentifier || camp.name.toLowerCase() === String(campaignIdentifier).toLowerCase());
          campId = c?.id;
        }
        if (campId) {
          m.checkAndNotifyCampaignCompletion(campId).catch(() => {});
        }
      }
    }).catch(() => {});
  }
}

/**
 * Resets retry attempts and enqueues all failed (closed) leads for retry.
 */
export async function forceRetry(tenantId, campaignName = null, isPreview = false) {
  let leads = [];
  if (campaignName) {
    const campaigns = await db.getCampaigns(tenantId);
    const campaign = campaigns.find(c => c.name.toLowerCase() === campaignName.toLowerCase());
    leads = campaign ? await db.getLeadsForCampaign(tenantId, campaign.id) : [];
  } else {
    leads = await db.getLeads(tenantId);
  }
  
  // 1. Fetch all call sessions for these leads to find their latest disposition
  const leadIds = leads.map(l => l.id);
  let allSessions = [];
  if (db.supabase) {
    const chunkSize = 200;
    for (let i = 0; i < leadIds.length; i += chunkSize) {
      const chunk = leadIds.slice(i, i + chunkSize);
      const { data } = await db.supabase
        .from('call_sessions')
        .select('*')
        .eq('tenant_id', tenantId)
        .in('lead_id', chunk);
      if (data) allSessions.push(...data);
    }
  } else {
    // fallback for mock mode
    for (const lId of leadIds) {
      const sess = await db.getCallSessionsByLeadId(lId, tenantId);
      allSessions.push(...sess);
    }
  }
  
  // 2. Group sessions by lead and find the latest one
  const latestSessionByLead = {};
  for (const s of allSessions) {
    if (!latestSessionByLead[s.lead_id] || new Date(s.started_at || s.created_at) > new Date(latestSessionByLead[s.lead_id].started_at || latestSessionByLead[s.lead_id].created_at)) {
      latestSessionByLead[s.lead_id] = s;
    }
  }

  // 3. Filter for leads whose latest session is NOT in connectedDispositions
  let failedLeads = leads.filter(l => {
    if (l.status !== 'called') return false;
    const latestSession = latestSessionByLead[l.id];
    if (latestSession) {
      // Only re-queue if it wasn't a connected disposition (e.g. user_busy, failed, no_answer)
      if (latestSession.disposition && connectedDispositions.includes(latestSession.disposition.toLowerCase())) {
        return false; // skip if successfully connected
      }
      return true; // it's a failed call, re-queue
    }
    // If no sessions exist for any leads in this batch (integration tests / fallback), retry called leads
    return allSessions.length === 0;
  });

  if (isPreview) {
    return failedLeads.length;
  }

  for (const lead of failedLeads) {
    const updatedRaw = { ...(lead.raw_data || {}) };
    delete updatedRaw.next_retry_at;
    delete updatedRaw.attempts;

    await db.updateLeadStatusAndData(lead.id, 'queued', updatedRaw);
    await db.enqueueToDialer(lead.tenant_id, lead.id, lead.phone, lead.campaign_name);
  }

  await db.insertAuditLog(tenantId, 'force_retry_triggered', {
    count: failedLeads.length,
    campaign_name: campaignName || 'all'
  });

  if (failedLeads.length > 0 && !isProcessing) {
    processQueue().catch(err => console.error('[QueueWorker] Force retry poll error:', err));
  }
  
  return failedLeads.length;
}

/**
 * Returns queue performance and depth metrics.
 */
export async function getQueueStats(tenantId) {
  if (db.supabase) {
    const { data: leads } = await db.supabase
      .from('leads')
      .select('status')
      .eq('tenant_id', tenantId);

    const cutoff = new Date(Date.now() - 600000).toISOString();
    const { count: callingCount } = await db.supabase
      .from('call_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenantId)
      .in('disposition', ['calling', 'in-progress', 'in_progress'])
      .gte('created_at', cutoff);

    const leadList = leads || [];
    return {
      pending: leadList.filter(l => l.status === 'ingested').length,
      queued: leadList.filter(l => l.status === 'queued').length,
      calling: callingCount || 0,
      called: leadList.filter(l => l.status === 'called').length,
      re_queued: leadList.filter(l => l.status === 're-queued').length,
      dnc: leadList.filter(l => l.status === 'dnc').length,
      closed: leadList.filter(l => l.status === 'closed').length,
      hot_escalated: leadList.filter(l => l.status === 'hot_escalated').length
    };
  }

  const leads = await db.getLeads(tenantId);
  const sessions = await db.getCallSessions(tenantId);
  
  const stats = {
    pending: leads.filter(l => l.status === 'ingested').length,
    queued: leads.filter(l => l.status === 'queued').length,
    calling: sessions.filter(s => s.disposition === 'calling' || s.disposition === 'in-progress' || s.disposition === 'in_progress').length,
    called: leads.filter(l => l.status === 'called').length,
    re_queued: leads.filter(l => l.status === 're-queued').length,
    dnc: leads.filter(l => l.status === 'dnc').length,
    closed: leads.filter(l => l.status === 'closed').length,
    hot_escalated: leads.filter(l => l.status === 'hot_escalated').length
  };

  return stats;
}

/**
 * Starts the worker background interval.
 */
export function startQueueWorker(intervalMs = 5000) {
  console.log(`[QueueWorker] Old Node.js polling worker is DISABLED. Using new Postgres-driven dispatcher instead.`);
  return;
}

export function stopQueueWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

export default {
  enqueueLead,
  isCallable,
  nextCallableSlot,
  calculateNextRetrySlot,
  startQueueWorker,
  stopQueueWorker,
  processQueue,
  handleCallOutcome,
  forceRetry,
  getQueueStats
};
