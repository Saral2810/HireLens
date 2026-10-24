import crypto from 'crypto';
import { VoiceProvider, NotImplementedError } from './base.js';
import { resolveAgentVariables } from '../variableMapping/index.js';
import { logExternalCall, generateRequestId } from '../observability/externalCallLogger.js';

/**
 * ─── Gnani.ai voice provider adapter (STUB — fill in the TODOs) ─────────────
 *
 * This is the one place the "brain" plugs into the framework. Every other part
 * of the app (dispatcher, queue, webhooks, scoring, dashboard) only talks to the
 * methods below, so once these work, the whole calling engine works with Gnani.
 *
 * Where credentials come from (first match wins):
 *   1. Per-tenant credentials saved through the Super Admin UI
 *      (stored encrypted in the tenant_voice_providers table)
 *   2. Your .env file: GNANI_API_BASE, GNANI_API_KEY, GNANI_AGENT_ID,
 *      GNANI_CALLER_ID, GNANI_WEBHOOK_SECRET
 *
 * If no API key is set, the adapter runs in MOCK mode: it pretends to place the
 * call and returns a fake session id, so you can test the full pipeline locally.
 *
 * NOTE: The request URLs / field names below are placeholders. Replace them with
 * the real ones from Gnani's API documentation.
 */
export class GnaniProvider extends VoiceProvider {
  constructor(credentials = {}) {
    super(credentials);
    this.providerType = 'gnani';
    this.tenantId      = credentials.tenant_id || null;
    this.apiBase       = (credentials.api_base       || process.env.GNANI_API_BASE       || '').replace(/\/+$/, '');
    this.apiKey        =  credentials.api_key        || process.env.GNANI_API_KEY        || '';
    this.agentId       =  credentials.agent_id       || process.env.GNANI_AGENT_ID       || '';
    this.agentName     =  credentials.agent_name     || process.env.GNANI_AGENT_NAME     || 'Gnani Voice Agent';
    this.callerId      =  credentials.caller_id      || process.env.GNANI_CALLER_ID      || '';
    this.webhookSecret =  credentials.webhook_secret || process.env.GNANI_WEBHOOK_SECRET || '';
  }

  _isMock() {
    return !this.apiKey || !this.apiBase || this.apiKey.startsWith('mock_');
  }

  _headers() {
    // TODO: confirm Gnani's auth header format (Bearer token, x-api-key, etc.)
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`
    };
  }

  async _request(method, path, body) {
    const url = `${this.apiBase}${path}`;
    const requestId = generateRequestId();
    const startTime = Date.now();
    let response = null;
    let respBody = null;
    let fetchErr = null;
    try {
      response = await fetch(url, {
        method,
        headers: this._headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
      try { respBody = await response.clone().text(); } catch { /* ignore */ }
    } catch (err) {
      fetchErr = err;
    } finally {
      await logExternalCall({
        service: 'gnani', endpoint: url, method, request_id: requestId,
        payload: body || null,
        response_status: response ? response.status : null,
        response_body: respBody,
        duration_ms: Date.now() - startTime,
        error: fetchErr ? fetchErr.message : null
      }).catch(() => {});
    }
    if (fetchErr) throw fetchErr;
    if (!response.ok) throw new Error(`[Gnani] ${method} ${path} failed: ${response.status} ${respBody || ''}`);
    try { return JSON.parse(respBody || '{}'); } catch { return {}; }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Called by the dispatcher for each lead. Must return { provider_session_id }. */
  async initSession(lead, scriptContext = {}, webhookUrl = '') {
    const agentId = lead.assigned_agent_id || scriptContext?.voice_agent_id || this.agentId;
    if (!agentId) {
      throw new Error(`[Gnani] No agent id for lead ${lead.id}. Set campaign.voice_agent_id or GNANI_AGENT_ID.`);
    }

    // Normalize phone to E.164 (assumes India if 10 digits)
    let phone = String(lead.phone || '').replace(/[^\d+]/g, '');
    if (!phone.startsWith('+')) {
      phone = phone.length === 10 ? `+91${phone}` : `+${phone}`;
    }

    // Lead fields -> agent variables (configured on the Agents page)
    const variables = await resolveAgentVariables(
      lead.tenant_id, this.providerType, agentId, lead, scriptContext?.campaign
    ).catch(() => ({}));

    let effectiveWebhookUrl = webhookUrl;
    if (effectiveWebhookUrl && lead.tenant_id && !effectiveWebhookUrl.includes('tenant_id=')) {
      effectiveWebhookUrl += (effectiveWebhookUrl.includes('?') ? '&' : '?') + `tenant_id=${encodeURIComponent(lead.tenant_id)}`;
    }

    const result = await this.initiateCall(phone, agentId, variables, effectiveWebhookUrl, lead.id);
    return {
      provider_session_id: result.session_id,
      status: 'initiated'
    };
  }

  /** Places the outbound call. Returns { session_id }. */
  async initiateCall(phone, agentId, variables = {}, webhookUrl = '', leadId = null) {
    if (this._isMock()) {
      const session_id = `mock-gnani-${crypto.randomUUID()}`;
      console.log(`[Gnani MOCK] Would call ${phone} with agent ${agentId}. session=${session_id}`);
      return { session_id };
    }

    // TODO: replace path + body with Gnani's real "start outbound call" API
    const data = await this._request('POST', '/calls/outbound', {
      agent_id: agentId,
      to: phone,
      from: this.callerId || undefined,
      variables,
      webhook_url: webhookUrl,
      metadata: { lead_id: leadId, tenant_id: this.tenantId }
    });

    const session_id = data.call_id || data.session_id || data.id;
    if (!session_id) throw new Error('[Gnani] Outbound call response had no call/session id');
    return { session_id };
  }

  /** Optional keep-alive. Gnani manages its own call lifecycle, so this is a no-op. */
  startHeartbeat(/* sessionId */) {}

  /** Optional: free any provider-side slot when the call ends. */
  async releaseSlot(/* sessionId */) {}

  // ── Webhooks ─────────────────────────────────────────────────────────────

  /**
   * Turns Gnani's webhook body into the shape the framework understands.
   * Return null to reject the request (e.g. bad signature).
   *
   * Required return shape:
   * {
   *   session_id,                 // provider call id
   *   event_type,                 // 'call_started' | 'call_ended' | 'escalation_triggered' | 'tool_call'
   *   payload: { disposition, transcript, summary, duration_seconds, recording_url, sentiment, lead_id },
   *   timestamp, agent_id
   * }
   */
  async parseWebhook(req, rawBodyString) {
    if (this.webhookSecret) {
      // TODO: confirm Gnani's signature header name + algorithm
      const sig = req.headers?.['x-gnani-signature'];
      if (!sig) return null;
      const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBodyString || '').digest('hex');
      try {
        if (expected.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
      } catch { return null; }
    }

    const body = typeof rawBodyString === 'string' && rawBodyString ? JSON.parse(rawBodyString) : (req.body || {});
    const data = body.data || body;

    // TODO: map Gnani's real field names here
    const sessionId = data.call_id || data.session_id || data.id;
    const status = String(data.status || data.disposition || 'completed').toLowerCase();
    const terminal = ['completed', 'ended', 'no_answer', 'busy', 'failed'];
    const eventType = body.event_type || body.event || (terminal.includes(status) ? 'call_ended' : status);

    let transcript = data.transcript || data.messages || null;
    if (Array.isArray(transcript)) {
      transcript = transcript.map(t => {
        const isAgent = ['agent', 'assistant', 'bot'].includes(t.role || t.speaker);
        const msg = t.text || t.message || t.content || '';
        return { role: isAgent ? 'assistant' : 'user', speaker: isAgent ? 'agent' : 'customer', message: msg, text: msg };
      });
    }

    const duration = data.duration_seconds ?? data.duration ?? 0;
    return {
      session_id: sessionId,
      event_type: eventType,
      payload: {
        ...body,
        disposition: data.disposition || status,
        status,
        summary: data.summary || '',
        transcript,
        transcript_json: transcript,
        duration_seconds: duration,
        duration,
        recording_url: data.recording_url || null,
        sentiment: data.sentiment || null,
        lead_id: data.metadata?.lead_id || body.metadata?.lead_id || null
      },
      timestamp: new Date().toISOString(),
      agent_id: data.agent_id || null
    };
  }

  /**
   * Fetch the final transcript / recording after a call.
   * Return shape: { transcript, recording_url, duration_seconds, disposition, summary, sentiment }
   */
  async fetchArtifacts(callId /*, extra */) {
    if (this._isMock() || !callId || String(callId).startsWith('mock-')) {
      return {
        transcript: [
          { role: 'assistant', speaker: 'agent', message: 'Hello, this is an AI assistant calling. Is this a good time?' },
          { role: 'user', speaker: 'customer', message: 'Yes, tell me more.' }
        ],
        recording_url: null,
        duration_seconds: 30,
        disposition: 'completed',
        summary: 'Mock call completed.',
        sentiment: 'neutral'
      };
    }
    // TODO: replace with Gnani's real "get call details" API
    const data = await this._request('GET', `/calls/${encodeURIComponent(callId)}`);
    return {
      transcript: data.transcript || null,
      recording_url: data.recording_url || null,
      duration_seconds: data.duration_seconds ?? data.duration ?? 0,
      disposition: data.disposition || data.status || null,
      summary: data.summary || null,
      sentiment: data.sentiment || null
    };
  }

  // ── Agents ───────────────────────────────────────────────────────────────

  /** List of agents shown on the Agents page. */
  async getAgents() {
    const configured = this.agentId ? [{
      agent_id: this.agentId,
      name: this.agentName,
      agent_name: this.agentName,
      provider: 'gnani',
      configuration: { channel: 'voice' },
      is_active: true
    }] : [];
    if (this._isMock()) return configured;

    try {
      // TODO: replace with Gnani's real "list agents" API (if it exists)
      const data = await this._request('GET', '/agents');
      const list = data.agents || data.data || (Array.isArray(data) ? data : []);
      if (!Array.isArray(list) || list.length === 0) return configured;
      return list.map(a => ({
        agent_id: a.agent_id || a.id,
        name: a.name || a.agent_name || a.id,
        provider: 'gnani',
        configuration: { channel: 'voice', language: a.language || null },
        is_active: true
      }));
    } catch {
      return configured;
    }
  }

  /** Variables your Gnani agent expects. Edit to match your agent's prompt. */
  async getAgentExpectedVariables(/* agentId */) {
    return [
      { name: 'customer_name', required: true, description: 'Customer full name' }
      // TODO: add the variables your Gnani agent uses
    ];
  }

  async getCallStatus(/* sessionId */) {
    throw new NotImplementedError('getCallStatus');
  }
}

export default GnaniProvider;
