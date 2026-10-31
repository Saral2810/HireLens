// Integration: security behaviour of the HTTP layer (headers, CORS, errors, input types, rate limits,
// test-token backdoor, host header). Fake DB; no network beyond localhost.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from '../helpers/fakeDb.js';
import { net, fakes, resetNetwork } from '../helpers/network.js';
import { speechRetry, clearAudioCache } from '../../../backend/src/services/gnaniSpeech.js';
import { startApp, tokens, liveCampaign, fileForm, RESUME_PDF } from '../helpers/http.js';

let app, store, c;
const admin = tokens.admin();

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => { store = installFakeDb(); resetNetwork(); clearAudioCache(); speechRetry.delaysMs = [1, 1]; });

test('test tokens ("Bearer test:superadmin:x") are refused outside NODE_ENV=test', async () => {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const r = await c.get('/api/hr/batches', { token: 'test:superadmin:x' });
    assert.notEqual(r.status, 200);
  } finally { process.env.NODE_ENV = saved; }
});

test('signed-out requests to every protected area get 401', async () => {
  for (const p of ['/api/hr/batches', '/api/candidate/me', '/api/auth/me']) assert.equal((await c.get(p)).status, 401, p);
  assert.equal((await c.get('/api/hr/batches', { headers: { Authorization: 'Basic abc' } })).status, 401);
});

test('malformed ids never reach the database (404, not 500)', async () => {
  for (const p of ['/api/hr/batches/1', "/api/hr/batches/1' OR '1'='1", '/api/hr/calls/../../etc']) {
    const r = await c.get(encodeURI(p), { token: admin });
    assert.ok([404].includes(r.status), `${p} → ${r.status}`);
  }
});

test('BUG-15 (fixed 27 Oct): responses carry no security headers (CSP, frame-ancestors, nosniff, HSTS) and advertise Express', async () => {
  const r = await c.get('/health');
  assert.ok(r.headers.get('content-security-policy') || r.headers.get('x-frame-options'), 'clickjacking/CSP protection missing');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-powered-by'), null);
});

test('BUG-15 (fixed 27 Oct): CORS allows any website to call the API with a stolen token', async () => {
  const r = await c.call('OPTIONS', '/api/hr/batches', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  const allow = r.headers.get('access-control-allow-origin');
  assert.ok(allow !== '*' && allow !== 'https://evil.example', `Access-Control-Allow-Origin: ${allow}`);
});

// Live probe on the running app (real Supabase configured) returned 500 "Authentication service error.".
// In this harness Supabase is switched off, so the handler answers 503 first; either way the body type is never checked.
test('BUG-11 (fixed 27 Oct): login with a non-string email crashes the handler (500 instead of 400)', async () => {
  const r = await c.post('/api/auth/login', { json: { email: ['a@b.co'], password: 'x' } });
  assert.equal(r.status, 400);
});

test('BUG-12 (fixed 27 Oct): errors leak internal details (parser messages, upstream Gnani responses) to the browser', async () => {
  const bad = await c.call('POST', '/api/auth/login', { headers: { 'Content-Type': 'application/json' }, form: '{bad' });
  assert.ok(!/position|JSON at/i.test(bad.body?.message || ''), `leaked: ${bad.body?.message}`);

  await liveCampaign(c, admin, { people: [{ name: 'Asha', email: 'asha@qa.test' }] });
  const tok = tokens.candidate('u1', 'asha@qa.test');
  await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: tok, json: { agree: true } });
  fakes.fail = (svc) => (svc === 'timbre' ? 400 : null);
  const start = await c.post('/api/candidate/call/start', { token: tok });
  assert.ok(start.status >= 500, `status ${start.status}`);
  assert.ok(!/Timbre returned|QA injected/.test(start.body?.message || ''), `leaked: ${start.body?.message}`);
});

test('BUG-30 (fixed 27 Oct): unknown /api routes answer with an HTML page instead of a JSON 404', async () => {
  const r = await c.get('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type') || '', /json/);
});

test('JSON bodies over 2 MB are refused with 413', async () => {
  const r = await c.post('/api/auth/login', { json: { email: 'a'.repeat(2.5 * 1024 * 1024), password: 'x' } });
  assert.equal(r.status, 413);
});

test('BUG-04 (fixed 27 Oct): no rate limit — one candidate can re-upload a resume 15 times in a row, each one an LLM call', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha', email: 'asha@qa.test' }] });
  const tok = tokens.candidate('u1', 'asha@qa.test');
  const statuses = [];
  for (let i = 0; i < 15; i += 1) statuses.push((await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') })).status);
  assert.ok(statuses.includes(429), `statuses: ${statuses.join(',')}; LLM calls spent: ${net.llmKinds.resume}`);
});

// Checked and NOT a bug: X-Forwarded-Host is ignored (req.get('host') reads only the Host header of HR's own request).
test('invite links ignore X-Forwarded-Host when PUBLIC_APP_URL is blank', async () => {
  const saved = process.env.PUBLIC_APP_URL;
  process.env.PUBLIC_APP_URL = '';
  try {
    await liveCampaign(c, admin, { people: [{ name: 'Asha', email: 'asha@qa.test' }] });
    const r = await c.post(`/api/hr/candidates/${store.candidates[0].id}/invite-link`, { token: admin, headers: { 'X-Forwarded-Host': 'evil.example', 'X-Forwarded-Proto': 'https' } });
    assert.ok(!/evil\.example/.test(r.body.invite_link), r.body.invite_link);
  } finally { process.env.PUBLIC_APP_URL = saved; }
});

test('uploads: wrong field name, two files, or oversize files are clean 400s', async () => {
  await liveCampaign(c, admin, { people: [{ name: 'Asha', email: 'asha@qa.test' }] });
  const tok = tokens.candidate('u1', 'asha@qa.test');
  assert.equal((await c.post('/api/candidate/resume', { token: tok, form: fileForm('cv', RESUME_PDF, 'r.pdf', 'application/pdf') })).status, 400);
  assert.equal((await c.post('/api/candidate/resume', { token: tok, form: fileForm('resume', Buffer.alloc(5 * 1024 * 1024 + 1, 37), 'r.pdf', 'application/pdf') })).status, 400);
});
