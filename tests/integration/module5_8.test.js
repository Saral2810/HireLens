import test from 'node:test';
import assert from 'node:assert';
import http from 'http';
import app from '../../backend/src/app.js';
import db from '../../backend/src/config/db.js';
import { checkEscalation } from '../../backend/src/services/escalationService.js';
import { handleEscalation } from '../../backend/src/services/handoffService.js';
import { validateScript } from '../../backend/src/utils/validation.js';

let server;
let port;
let baseUrl;

test.before(async () => {
  process.env.NODE_ENV = 'test';
  await db.clearDb();

  return new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, () => {
      port = server.address().port;
      baseUrl = `http://localhost:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

// Mock reference script config
const testScriptConfig = {
  tenant_id: 'test-tenant',
  script_id: 'edtech-admissions',
  version: '1.0',
  language: 'en',
  max_duration_seconds: 300,
  escalation_triggers: [
    { type: 'explicit_request', phrases: ['speak to advisor', 'talk to human', 'transfer', 'supervisor', 'agent'] },
    { type: 'sentiment_low', threshold: 0.3 },
    { type: 'high_intent', phrases: ['i want to enroll', 'how do i pay', 'when does course start', 'send syllabus'] },
    { type: 'max_duration', seconds: 250 }
  ],
  nodes: [
    { id: 'intro', prompt: 'Hello {lead_name}, welcome.', expected_intents: ['greeting'], branches: { greeting: 'pitch' } },
    { id: 'pitch', prompt: 'We offer advanced AI coding masterclasses.', expected_intents: ['interest'], branches: { interest: 'close' } },
    { id: 'close', prompt: 'Great, would you like to enroll today?', expected_intents: ['yes', 'no'], branches: {}, is_terminal: true }
  ]
};

// ============================================================
// MODULE 5: 22 ESCALATION TEST CASES (10 Trigger, 10 No-Trigger, 2 Edge)
// ============================================================

test('Escalation Detection - 10 Trigger Cases', () => {
  const triggers = [
    // 1. Explicit phrase "supervisor"
    { transcript: 'I want to speak with a supervisor', duration: 30, sentiment: 0.5, expectedReason: 'explicit_request' },
    // 2. Explicit phrase "talk to human"
    { transcript: 'Can I talk to human please?', duration: 12, sentiment: 0.5, expectedReason: 'explicit_request' },
    // 3. Explicit phrase "transfer"
    { transcript: 'transfer this call now', duration: 40, sentiment: 0.5, expectedReason: 'explicit_request' },
    // 4. Low sentiment numeric (0.1 < 0.3)
    { transcript: 'This is not what I expected', duration: 60, sentiment: 0.1, expectedReason: 'sentiment_low' },
    // 5. Low sentiment string mapping to 0.1
    { transcript: 'I am very frustrated', duration: 45, sentiment: 'negative', expectedReason: 'sentiment_low' },
    // 6. Low sentiment string "angry" mapping to 0.1
    { transcript: 'No, stop calling me', duration: 25, sentiment: 'angry', expectedReason: 'sentiment_low' },
    // 7. High-intent phrase "i want to enroll"
    { transcript: 'Oh yes, i want to enroll in the program', duration: 55, sentiment: 0.8, expectedReason: 'high_intent' },
    // 8. High-intent phrase "how do i pay"
    { transcript: 'Ok how do i pay for this course?', duration: 70, sentiment: 0.8, expectedReason: 'high_intent' },
    // 9. Call duration exceeded trigger-specific limit (260s > 250s)
    { transcript: 'Just checking course structure.', duration: 260, sentiment: 0.6, expectedReason: 'max_duration' },
    // 10. Call duration exceeded script-root limit (310s > 300s)
    { transcript: 'Yes I am still here thinking.', duration: 310, sentiment: 0.7, expectedReason: 'max_duration' }
  ];

  triggers.forEach((t, i) => {
    const res = checkEscalation(t.transcript, t.duration, t.sentiment, testScriptConfig);
    assert.strictEqual(res.shouldEscalate, true, `Trigger Case #${i+1} failed to escalate: ${JSON.stringify(t)}`);
    assert.strictEqual(res.reason, t.expectedReason, `Trigger Case #${i+1} got incorrect reason: ${res.reason}`);
  });
});

test('Escalation Detection - 10 No-Trigger Cases', () => {
  const noTriggers = [
    // 1. General conversation
    { transcript: 'Hello, good afternoon', duration: 15, sentiment: 0.6 },
    // 2. Inquiring about placements
    { transcript: 'Do you offer job placements after class?', duration: 50, sentiment: 0.5 },
    // 3. Positive feedback
    { transcript: 'That sounds like a very good curriculum indeed', duration: 80, sentiment: 'positive' },
    // 4. High sentiment numeric (0.9 > 0.3)
    { transcript: 'Nice program details', duration: 30, sentiment: 0.9 },
    // 5. Neutral string sentiment
    { transcript: 'Okay, tell me more', duration: 110, sentiment: 'neutral' },
    // 6. Typical duration (120s < 250s)
    { transcript: 'Is it online or classroom?', duration: 120, sentiment: 0.5 },
    // 7. Simple response
    { transcript: 'Yes please', duration: 200, sentiment: 0.7 },
    // 8. Discussing price details (no low sentiment or high intent triggers yet)
    { transcript: 'What is the fee structure?', duration: 150, sentiment: 0.5 },
    // 9. Negative statement that does not map to low sentiment or key phrases
    { transcript: 'I am not sure yet', duration: 90, sentiment: 0.4 },
    // 10. General interest check
    { transcript: 'Okay, please email the info.', duration: 180, sentiment: 0.5 }
  ];

  noTriggers.forEach((t, i) => {
    const res = checkEscalation(t.transcript, t.duration, t.sentiment, testScriptConfig);
    assert.strictEqual(res.shouldEscalate, false, `No-Trigger Case #${i+1} escalated unexpectedly: ${JSON.stringify(t)}`);
  });
});

test('Escalation Detection - 2 Edge Cases', () => {
  // Edge Case 1: Missing transcript/null fields
  const res1 = checkEscalation(null, 10, null, testScriptConfig);
  assert.strictEqual(res1.shouldEscalate, false, 'Edge Case #1: Null transcript should not trigger escalation');

  // Edge Case 2: Boundary value (duration is exactly 250s, matching the max_duration trigger)
  const res2 = checkEscalation('Still talking about things', 250, 0.5, testScriptConfig);
  assert.strictEqual(res2.shouldEscalate, true, 'Edge Case #2: Exact boundary duration should trigger');
  assert.strictEqual(res2.reason, 'max_duration');
});

// ============================================================
// MODULE 5: SCRIPT SCHEMA VALIDATION & API ENDPOINTS
// ============================================================

test('Script Validator - Validation Checks', () => {
  // Valid Script
  const valResult = validateScript(testScriptConfig);
  assert.strictEqual(valResult.isValid, true);

  // Invalid: Missing version and nodes
  const invalidScript = {
    tenant_id: 'test-tenant',
    script_id: 'invalid-one'
  };
  const valResult2 = validateScript(invalidScript);
  assert.strictEqual(valResult2.isValid, false);
  assert.ok(valResult2.errors.includes('version is required'));
  assert.ok(valResult2.errors.includes('nodes must be a non-empty array'));
});

test('POST & GET /leads/scripts - Save and retrieve script', async () => {
  // Save Script
  const saveRes = await fetch(`${baseUrl}/leads/scripts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testScriptConfig)
  });
  assert.strictEqual(saveRes.status, 201);
  const saveData = await saveRes.json();
  assert.strictEqual(saveData.success, true);
  assert.strictEqual(saveData.script.script_id, 'edtech-admissions');

  // Get Scripts List
  const listRes = await fetch(`${baseUrl}/leads/scripts?tenant_id=test-tenant`);
  assert.strictEqual(listRes.status, 200);
  const listData = await listRes.json();
  assert.strictEqual(listData.success, true);
  assert.ok(listData.scripts.length > 0);

  // Get Script by script_id & tenant_id
  const getRes = await fetch(`${baseUrl}/leads/scripts/edtech-admissions?tenant_id=test-tenant&version=1.0`);
  assert.strictEqual(getRes.status, 200);
  const getData = await getRes.json();
  assert.strictEqual(getData.success, true);
  assert.strictEqual(getData.script.script_id, 'edtech-admissions');
});

// ============================================================
// MODULE 6: ASYNC HANDOFF & AGENT BRIEF & INSTANT CALL
// ============================================================

test('Handoff & Agent Brief & Instant Call APIs', async () => {
  // Ingest Lead first
  const payload = {
    tenant_id: 'test-tenant',
    client_id: 'handoff-test-1',
    name: 'Handoff Test User',
    phone: '9988771122',
    source: 'referral',
    campaign_name: 'test_campaign'
  };
  await db.insertCampaign({ tenant_id: 'test-tenant', name: 'test_campaign', voice_agent_id: 'agent_test' });
  const ingestRes = await fetch(`${baseUrl}/leads/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const ingestData = await ingestRes.json();
  const leadId = ingestData.lead.id;

  // Update onboarding config to make active_script_id = 'edtech-admissions'
  await fetch(`${baseUrl}/leads/onboard`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'test-tenant',
      onboarding_config: {
        active_script_id: 'edtech-admissions',
        concurrent_call_limit: 2
      }
    })
  });

  // Start Call Session
  const callRes = await fetch(`${baseUrl}/leads/trigger-call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: 'test-tenant', lead_id: leadId })
  });
  const callData = await callRes.json();
  const providerSessionId = callData.provider_session_id;

  // Dispatch mock event with low sentiment to trigger checkEscalation inside webhook
  const webhookRes = await fetch(`${baseUrl}/leads/webhook/mock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'test-tenant',
      lead_id: leadId,
      event_type: 'objection_raised',
      phone: '+919999912345',
      agent_name: 'Kavita_TAGtesttag',
      payload: {
        provider_session_id: providerSessionId,
        transcript: 'I want to speak with a human agent', // triggers explicit request
        sentiment: 'negative'
      }
    })
  });
  assert.strictEqual(webhookRes.status, 200);

  // Check lead status is updated to 'hot_escalated'
  const leadObj = await db.findLeadById(leadId);
  assert.strictEqual(leadObj.status, 'hot_escalated');

  // Fetch Agent Brief
  const briefRes = await fetch(`${baseUrl}/leads/handoff/brief/${leadId}?tenant_id=test-tenant`);
  assert.strictEqual(briefRes.status, 200);
  const briefData = await briefRes.json();
  assert.strictEqual(briefData.success, true);
  assert.strictEqual(briefData.brief.lead_name, 'Handoff Test User');
  assert.strictEqual(briefData.brief.escalation_reason, 'explicit_request');

  // Test Instant Call
  const instantRes = await fetch(`${baseUrl}/leads/calls/instant`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tenant_id: 'test-tenant', lead_id: leadId })
  });
  assert.strictEqual(instantRes.status, 200);
  const instantData = await instantRes.json();
  assert.strictEqual(instantData.success, true);
  // Dial mode will either be 'instant' or 'queued_high_priority' depending on active calls
  assert.ok(instantData.dial_mode);
});

// ============================================================
// MODULE 7: ANALYTICS SUMMARY
// ============================================================

test('GET /leads/analytics/summary - Retrieve funnel and KPI metrics', async () => {
  const res = await fetch(`${baseUrl}/leads/analytics/summary?tenant_id=test-tenant`);
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.success, true);
  assert.ok(data.kpis);
  assert.ok(data.funnel);
  assert.ok(Array.isArray(data.dispositions));
});

// ============================================================
// MODULE 9: CAMPAIGN DELETION
// ============================================================

test('DELETE /leads/campaigns - Delete all leads associated with a campaign', async () => {
  // Ingest a mock lead with campaign name "DeleteMeCampaign"
  const ingestRes = await fetch(`${baseUrl}/leads/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'test-tenant',
      name: 'Delete Target Lead',
      phone: '9988772299',
      email: 'delete.target@example.com',
      source: 'crm',
      client_id: 'hs-del-901',
      campaign_name: 'DeleteMeCampaign'
    })
  });
  assert.strictEqual(ingestRes.status, 201);

  // Verify it exists in campaigns list
  const listRes = await fetch(`${baseUrl}/leads/campaigns?tenant_id=test-tenant`);
  const listData = await listRes.json();
  const names = listData.campaigns.map(c => c.name);
  assert.ok(names.includes('DeleteMeCampaign'));

  // Delete the campaign
  const deleteRes = await fetch(`${baseUrl}/leads/campaigns`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'test-tenant',
      campaign_name: 'DeleteMeCampaign'
    })
  });
  assert.strictEqual(deleteRes.status, 200);
  const deleteData = await deleteRes.json();
  assert.strictEqual(deleteData.success, true);

  // Verify it is gone from campaigns list
  const listRes2 = await fetch(`${baseUrl}/leads/campaigns?tenant_id=test-tenant`);
  const listData2 = await listRes2.json();
  const names2 = listData2.campaigns.map(c => c.name);
  assert.ok(!names2.includes('DeleteMeCampaign'));
});


test('POST /leads/ingest - Keep lead updated with its most recent campaign_id on duplicate append', async () => {
  // Ingest lead for the first campaign
  const ingestRes1 = await fetch(`${baseUrl}/leads/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'test-tenant',
      name: 'Most Recent Campaign ID Test User',
      phone: '9999955555',
      source: 'crm',
      client_id: 'hs-mrc-201',
      campaign_name: 'FirstCampaign',
      raw_data: {
        platform_lead_id: 'tag-test-unique-id-999',
        campaign_id: 'cmp-test-first-id-001',
        crm_id: 'hs-mrc-201'
      }
    })
  });
  assert.strictEqual(ingestRes1.status, 201);

  // Verify first campaign_id is stored
  const leadRes1 = await fetch(`${baseUrl}/leads?tenant_id=test-tenant`);
  const leadData1 = await leadRes1.json();
  const lead1 = leadData1.leads.find(l => l.phone === '9999955555');
  assert.ok(lead1);
  assert.strictEqual(lead1.raw_data?.campaign_id, 'cmp-test-first-id-001');
  assert.strictEqual(lead1.raw_data?.platform_lead_id, 'tag-test-unique-id-999');

  // Ingest duplicate lead for the second campaign (should append and update campaign_id to second campaign_id)
  const ingestRes2 = await fetch(`${baseUrl}/leads/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tenant_id: 'test-tenant',
      name: 'Most Recent Campaign ID Test User',
      phone: '9999955555',
      source: 'crm',
      client_id: 'hs-mrc-201',
      campaign_name: 'SecondCampaign',
      raw_data: {
        campaign_id: 'cmp-test-second-id-002'
      }
    })
  });
  assert.strictEqual(ingestRes2.status, 200);

  // Verify campaign_id has updated to the most recent campaign_id, while platform_lead_id remains unchanged
  const leadRes2 = await fetch(`${baseUrl}/leads?tenant_id=test-tenant`);
  const leadData2 = await leadRes2.json();
  const lead2 = leadData2.leads.find(l => l.phone === '9999955555');
  assert.ok(lead2);
  assert.strictEqual(lead2.raw_data?.campaign_id, 'cmp-test-second-id-002');
  assert.strictEqual(lead2.raw_data?.platform_lead_id, 'tag-test-unique-id-999');
  assert.strictEqual(lead2.campaign_name, 'SecondCampaign');
});

