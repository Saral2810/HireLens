import crypto from 'crypto';
import { VoiceProvider } from './base.js';

/**
 * Offline mock provider — no real calls. Useful for local testing and unit tests.
 * Select it by setting a campaign's voice_provider to 'mock' (or DEFAULT_VOICE_PROVIDER=mock).
 */
export class MockProvider extends VoiceProvider {
  constructor(credentials = {}) {
    super(credentials);
    this.providerType = 'mock';
  }

  async initSession(lead) {
    const id = `mock-${crypto.randomUUID()}`;
    console.log(`[MockProvider] Simulated call to ${lead?.phone} (session ${id})`);
    return { provider_session_id: id, status: 'initiated' };
  }

  async initiateCall() {
    return { session_id: `mock-${crypto.randomUUID()}` };
  }

  startHeartbeat() {}
  async releaseSlot() {}

  async parseWebhook(req, rawBodyString) {
    const body = typeof rawBodyString === 'string' && rawBodyString ? JSON.parse(rawBodyString) : (req.body || {});
    const payload = { ...(body.payload || body) };
    if (!payload.lead_id && body.lead_id) payload.lead_id = body.lead_id;
    return {
      session_id: body.session_id || body.payload?.provider_session_id || body.provider_session_id,
      event_type: body.event_type || 'call_ended',
      payload,
      timestamp: new Date().toISOString(),
      agent_id: body.agent_id || null
    };
  }

  async fetchArtifacts() {
    return {
      transcript: [
        { role: 'assistant', speaker: 'agent', message: 'Hello, this is a test call.' },
        { role: 'user', speaker: 'customer', message: 'Okay.' }
      ],
      recording_url: null,
      duration_seconds: 10,
      disposition: 'completed',
      summary: 'Mock call.',
      sentiment: 'neutral'
    };
  }

  async getAgents() {
    return [{ agent_id: 'mock-agent', name: 'Mock Agent', provider: 'mock', configuration: { channel: 'voice' }, is_active: true }];
  }

  async getAgentExpectedVariables() {
    return [{ name: 'customer_name', required: false, description: 'Customer name' }];
  }
}

export default MockProvider;
