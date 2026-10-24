import test from 'node:test';
import assert from 'node:assert';
import db from '../../backend/src/config/db.js';
import { extractConsentStatus } from '../../backend/src/services/queueService.js';

test('Lead Consent Tracking & Priority Extraction', async (t) => {
  await t.test('1. Structured output priority: structuredOutputs.consent_status takes precedence', () => {
    const res = extractConsentStatus({
      structuredOutputs: { consent_status: 'agreed' },
      summary: 'Customer seemed hesitant and said no initially',
      transcript: 'No, maybe later',
      isFailure: false
    });
    assert.strictEqual(res, 'agreed');

    const resDeclined = extractConsentStatus({
      structuredOutputs: { consent_status: 'declined' },
      summary: 'Customer said yes send link',
      transcript: 'haan yes',
      isFailure: false
    });
    assert.strictEqual(resDeclined, 'declined');
  });

  await t.test('2. Regex affirmatives (Hindi/English) extracted as agreed', () => {
    assert.strictEqual(extractConsentStatus({
      summary: 'Customer said हां send details',
      isFailure: false
    }), 'agreed');

    assert.strictEqual(extractConsentStatus({
      transcript: 'haan please link भेज दो',
      isFailure: false
    }), 'agreed');

    assert.strictEqual(extractConsentStatus({
      transcript: 'yes please send the link to my phone',
      isFailure: false
    }), 'agreed');
  });

  await t.test('3. Regex denials (Hindi/English) extracted as declined', () => {
    assert.strictEqual(extractConsentStatus({
      summary: 'Customer said नहीं, not interested',
      isFailure: false
    }), 'declined');

    assert.strictEqual(extractConsentStatus({
      transcript: 'No I am not interested right now',
      isFailure: false
    }), 'declined');

    assert.strictEqual(extractConsentStatus({
      transcript: 'बाद में call karna, abhi busy hu',
      isFailure: false
    }), 'declined');
  });

  await t.test('4. Otherwise extracted as unclear', () => {
    assert.strictEqual(extractConsentStatus({
      summary: 'Agent asked about current loan status',
      transcript: 'I have an existing loan with another bank',
      isFailure: false
    }), 'unclear');
  });

  await t.test('5. Failure dispositions return not_asked', () => {
    assert.strictEqual(extractConsentStatus({
      isFailure: true
    }), 'not_asked');
  });

  await t.test('7. db.updateCallSession persists consent_status and consent_captured_at', async () => {
    const session = await db.insertCallSession({
      tenant_id: 'demo',
      lead_id: 'lead-test-consent-db',
      provider_session_id: 'mock-sess-consent-db',
      disposition: 'completed'
    });

    const now = new Date().toISOString();
    await db.updateCallSession(session.id, {
      consent_status: 'agreed',
      consent_captured_at: now
    });

    const sessions = await db.getCallSessions('demo');
    const updated = sessions.find(s => s.id === session.id);
    assert.strictEqual(updated.consent_status, 'agreed');
    assert.strictEqual(updated.consent_captured_at, now);
  });
});
