import test from 'node:test';
import assert from 'node:assert';
import db from '../../backend/src/config/db.js';
import { logExternalCall, redactPayload, generateRequestId } from '../../backend/src/services/observability/externalCallLogger.js';

test('External Call Logger & Redaction', async (t) => {
  await t.test('generateRequestId creates a short string', () => {
    const id = generateRequestId();
    assert.strictEqual(typeof id, 'string');
    assert.strictEqual(id.length, 8);
  });

  await t.test('redactPayload redacts sensitive headers and keys per spec', () => {
    const input = {
      headers: {
        'client-secret': 'super_secret_123',
        'xi-api-key': 'eleven_labs_key_456',
        'Authorization': 'Bearer token_789',
        'X-API-Key': 'provider_key_abc',
        'content-type': 'application/json'
      },
      body: {
        customer_id: 'cust_101',
        api_key: 'my_api_key',
        password: 'PlainTextPassword',
        secret_token: 'jwt.token.val',
        user_token: 'token_xyz',
        nested: {
          app_secret: 'nested_secret_val',
          normal_field: 'safe_value'
        }
      }
    };

    const redacted = redactPayload(input);
    assert.strictEqual(redacted.headers['client-secret'], '[REDACTED]');
    assert.strictEqual(redacted.headers['xi-api-key'], '[REDACTED]');
    assert.strictEqual(redacted.headers['Authorization'], '[REDACTED]');
    assert.strictEqual(redacted.headers['X-API-Key'], '[REDACTED]');
    assert.strictEqual(redacted.headers['content-type'], 'application/json');

    assert.strictEqual(redacted.body.customer_id, 'cust_101');
    assert.strictEqual(redacted.body.api_key, '[REDACTED]');
    assert.strictEqual(redacted.body.password, '[REDACTED]');
    assert.strictEqual(redacted.body.secret_token, '[REDACTED]');
    assert.strictEqual(redacted.body.user_token, '[REDACTED]');
    assert.strictEqual(redacted.body.nested.app_secret, '[REDACTED]');
    assert.strictEqual(redacted.body.nested.normal_field, 'safe_value');
  });

  await t.test('redactPayload truncates long transcripts to 100 chars + length', () => {
    const longText = 'A'.repeat(250);
    const input = {
      customer: 'John',
      transcript: longText
    };

    const redacted = redactPayload(input);
    assert.strictEqual(redacted.transcript, `${'A'.repeat(100)}... (length: 250)`);
  });

  await t.test('logExternalCall logs to console with [ExtCall] prefix and persists to DB', async () => {
    const originalLog = console.log;
    let loggedMsg = '';
    console.log = (msg) => {
      loggedMsg = msg;
    };

    try {
      const record = await logExternalCall({
        service: 'partner',
        endpoint: 'https://partner.example.com/v1/callback',
        method: 'POST',
        request_id: 'testreq1',
        tenant_id: 'demo',
        lead_id: 'lead_999',
        session_id: 'sess_888',
        payload: {
          headers: { 'client-secret': 'mysecret' },
          body: { loan_amount: 50000 }
        },
        response_status: 200,
        response_body: { status: 0, message: 'Success' },
        duration_ms: 42
      });

      assert.match(loggedMsg, /^\[ExtCall\]\[service=partner endpoint=https:\/\/partner\.example\.com\/v1\/callback req=testreq1\] POST status=200 42ms/);
      assert.strictEqual(record.payload.headers['client-secret'], '[REDACTED]');
      assert.strictEqual(record.payload.body.loan_amount, 50000);

      const logs = await db.getExternalCallLogs({ service: 'partner', tenant_id: 'demo' });
      assert.ok(logs.length > 0);
      const found = logs.find(l => l.request_id === 'testreq1');
      assert.ok(found);
      assert.strictEqual(found.service, 'partner');
      assert.strictEqual(found.response_status, 200);
      assert.strictEqual(found.duration_ms, 42);
    } finally {
      console.log = originalLog;
    }
  });
});
