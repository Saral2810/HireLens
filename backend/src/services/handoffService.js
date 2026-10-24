import db from '../config/db.js';
import { sendSlackNotification } from './slackService.js';
import { syncToCRM } from './crmService.js';

/**
 * Handles active call session escalation to human agent.
 * Marks the lead as hot_escalated, compiles session transcripts/objections into a brief,
 * notifies operations via Slack, saves the brief, and pushes the outcome to CRM.
 * 
 * @param {string} providerSessionId The session identifier from the voice provider.
 * @param {object} event The triggering event payload (e.g. escalation_triggered).
 * @returns {object} The generated agent brief.
 */
export async function handleEscalation(providerSessionId, event) {
  const session = await db.findCallSessionByProviderId(providerSessionId);
  if (!session) {
    throw new Error(`Call session with provider ID ${providerSessionId} not found`);
  }

  const lead = await db.findLeadById(session.lead_id);
  if (!lead) {
    throw new Error(`Lead associated with session ${session.id} not found`);
  }

  const tenantId = session.tenant_id;
  const leadId = lead.id;

  // Mark lead status as hot_escalated
  const updatedLead = await db.updateLeadStatus(leadId, 'hot_escalated');

  // Retrieve call events to summarize
  const events = await db.getCallEvents(tenantId);
  // Filter events for this session
  const sessionEvents = events.filter(e => e.session_id === session.id);

  // Analyze events for summary, key phrases, and objections
  let callSummary = event.payload?.summary || session.summary || 'Lead requested live operator assistance.';
  let keyPhrases = [];
  let objections = [];

  sessionEvents.forEach(e => {
    if (e.payload?.transcript) {
      keyPhrases.push(e.payload.transcript);
    }
    if (e.event_type === 'objection_raised') {
      if (e.payload?.objection_type) {
        objections.push(e.payload.objection_type);
      }
    }
  });

  if (keyPhrases.length === 0 && event.payload?.transcript) {
    keyPhrases.push(event.payload.transcript);
  }

  // Deduplicate objections
  objections = Array.from(new Set(objections));

  // Recommended action based on objections
  let recommendedAction = 'Contact the lead immediately by phone.';
  if (objections.some(o => o.toLowerCase().includes('price') || o.toLowerCase().includes('fee') || o.toLowerCase().includes('cost') || o.toLowerCase().includes('charge'))) {
    recommendedAction = 'Offer the 15% early-bird discount/scholarship and review monthly EMI plans.';
  } else if (objections.some(o => o.toLowerCase().includes('time') || o.toLowerCase().includes('schedule') || o.toLowerCase().includes('work'))) {
    recommendedAction = 'Propose weekend-only or evening part-time batch options.';
  } else if (objections.some(o => o.toLowerCase().includes('syllabus') || o.toLowerCase().includes('curriculum') || o.toLowerCase().includes('course'))) {
    recommendedAction = 'Email program brochure and schedule a curriculum walkthrough.';
  } else if (event.payload?.reason === 'human_negotiation_requested') {
    recommendedAction = 'Review current discount brackets and close registration manually.';
  }

  const briefData = {
    lead_name: lead.name || 'Anonymous Prospect',
    phone: lead.phone,
    score: lead.score,
    lead_score: lead.score,
    call_duration_seconds: session.duration || session.call_duration_seconds || 0,
    call_summary: callSummary,
    transcript_json: session.transcript_json || lead.raw_data?.transcript_json || event.payload?.transcript_json || null,
    recording_url: session.recording_url || session.audio_url || null,
    sentiment: session.sentiment || lead.raw_data?.sentiment || event.payload?.sentiment || 'neutral',
    analysis: session.analysis || lead.raw_data?.analysis || event.payload?.analysis || {},
    key_phrases: keyPhrases.slice(0, 5),
    objections: objections,
    recommended_action: recommendedAction,
    escalation_reason: event.payload?.reason || 'Explicit human handoff request',
    timestamp: new Date().toISOString()
  };

  // Save agent brief to database
  await db.upsertAgentBrief(tenantId, leadId, briefData);

  // Insert System Audit Log
  await db.insertAuditLog(tenantId, 'escalation_triggered', {
    lead_id: leadId,
    phone: lead.phone,
    reason: briefData.escalation_reason,
    session_id: session.id
  });

  // Slack Notification with brief details
  await sendSlackNotification(
    `[Escalation Alert] Active session "${providerSessionId}" escalated.\n` +
    `Lead: *${briefData.lead_name}* (${lead.phone})\n` +
    `Score: *${lead.score}/100*\n` +
    `Reason: ${briefData.escalation_reason}\n` +
    `Recommended Action: _${briefData.recommended_action}_`
  );

  // Sync back to CRM
  try {
    const provider = process.env.CRM_PROVIDER || null;
    await syncToCRM(tenantId, { ...updatedLead, status: 'hot_escalated' }, provider);
  } catch (crmErr) {
    console.warn('CRM handoff sync skipped/failed:', crmErr.message);
  }

  return briefData;
}

export default {
  handleEscalation
};
