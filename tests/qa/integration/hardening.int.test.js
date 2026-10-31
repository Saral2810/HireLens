// Integration: the Critical/High fixes of 27 Oct — call capacity (BUG-21), one turn at a time with
// replayable retries (BUG-05), the not-ready cap (BUG-07), rate limits (BUG-04), disk-backed recordings
// (BUG-10/08), invite-link scope (BUG-01) and the public-exposure hardening (BUG-32).
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import { installFakeDb } from '../helpers/fakeDb.js';
import { net, fakes, resetNetwork } from '../helpers/network.js';
import { speechRetry, clearAudioCache } from '../../../backend/src/services/gnaniSpeech.js';
import { NOT_READY_LIMIT_REASON } from '../../../backend/src/services/callFlow.js';
import { startApp, tokens, liveCampaign, takeCall, answerForm, fileForm, RESUME_PDF, WEBM_SAMPLE } from '../helpers/http.js';

let app, store, c;
const admin = tokens.admin();
const recA = tokens.recruiter('rec-a');
const recB = tokens.recruiter('rec-b');

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => { store = installFakeDb(); resetNetwork(); clearAudioCache(); speechRetry.delaysMs = [1, 1]; delete process.env.MAX_ACTIVE_CALLS; });

const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i + 1} Test`, email: `p${i + 1}@qa.test` }));
const tok = (i) => tokens.candidate(`u-p${i}`, `p${i}@qa.test`);
async function ready(token) {
  await c.post('/api/candidate/resume', { token, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token, json: { agree: true } });
}
const turnForm = (text, turnId) => { const f = answerForm(text); if (turnId) f.append('turn_id', turnId); return f; };

// ── BUG-21: capacity ──

test('BUG-21: past MAX_ACTIVE_CALLS, new calls wait (429 + Retry-After) and start once a line is free', async () => {
  process.env.MAX_ACTIVE_CALLS = '2';
  await liveCampaign(c, admin, { people: people(3) });
  for (const i of [1, 2, 3]) await ready(tok(i));
  assert.equal((await c.post('/api/candidate/call/start', { token: tok(1) })).status, 200);
  assert.equal((await c.post('/api/candidate/call/start', { token: tok(2) })).status, 200);
  const busy = await c.post('/api/candidate/call/start', { token: tok(3) });
  assert.equal(busy.status, 429);
  assert.equal(busy.body.code, 'lines_busy');
  assert.equal(busy.headers.get('retry-after'), '15');
  assert.equal(store.candidates.find(x => x.email === 'p3@qa.test').status, 'resume_uploaded', 'waiting does not change the candidate');
  assert.equal(store.calls.length, 2, 'no call (and no Timbre spend) for the waiting candidate');

  await c.post('/api/candidate/call/end', { token: tok(1), json: { reason: 'ended_by_candidate' } });
  assert.equal((await c.post('/api/candidate/call/start', { token: tok(3) })).status, 200);
});

test('BUG-21: a finished call frees its line; the waiting room retries do not use up the start limit', async () => {
  process.env.MAX_ACTIVE_CALLS = '1';
  await liveCampaign(c, admin, { people: people(2) });
  await ready(tok(2));
  const first = await takeCall(c, tok(1));
  assert.equal(first.body.outcome, 'completed');
  // The only line is free again, so P2 gets it...
  assert.equal((await c.post('/api/candidate/call/start', { token: tok(2) })).status, 200);
  // ...and Q waits. 35 busy answers in a row (more than the 30 starts allowed per hour) never lock Q out.
  await liveCampaign(c, admin, { name: 'Second', people: [{ name: 'Q', email: 'q@qa.test' }] });
  const q = tokens.candidate('u-q', 'q@qa.test');
  await ready(q);
  const statuses = [];
  for (let i = 0; i < 35; i += 1) statuses.push((await c.post('/api/candidate/call/start', { token: q })).status);
  assert.ok(statuses.every(s => s === 429), 'still waiting');
  assert.ok(statuses.every((s, i) => i === 0 || s === statuses[0]), 'all are "lines busy", none "rate limited"');
});

// ── BUG-05: one turn at a time ──

test('BUG-05: the browser retrying with the same turn_id gets the same reply, processed once', async () => {
  await liveCampaign(c, admin, { people: people(1) });
  await ready(tok(1));
  await c.post('/api/candidate/call/start', { token: tok(1) });
  fakes.latency.prisma = 30;
  const before = net.prisma;
  const [a, b] = await Promise.all([
    c.post('/api/candidate/call/turn', { token: tok(1), form: turnForm('haan ready', 'turn-1') }),
    c.post('/api/candidate/call/turn', { token: tok(1), form: turnForm('haan ready', 'turn-1') })
  ]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.deepEqual(a.body, b.body);
  // And a retry that arrives after the first finished (its reply was lost) is replayed too.
  const late = await c.post('/api/candidate/call/turn', { token: tok(1), form: turnForm('haan ready', 'turn-1') });
  assert.deepEqual(late.body, a.body);
  assert.equal(net.prisma - before, 1, 'Prisma ran once for the three requests');
  assert.equal(store.calls[0].transcript.filter(e => e.speaker === 'candidate').length, 1, 'transcript has the answer once');
});

test('BUG-05: a different answer while one is still processing is refused (409), not raced', async () => {
  await liveCampaign(c, admin, { people: people(1) });
  await ready(tok(1));
  await c.post('/api/candidate/call/start', { token: tok(1) });
  fakes.latency.prisma = 50;
  const [a, b] = await Promise.all([
    c.post('/api/candidate/call/turn', { token: tok(1), form: turnForm('haan', 'turn-a') }),
    c.post('/api/candidate/call/turn', { token: tok(1), form: turnForm('haan', 'turn-b') })
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
});

// ── BUG-07: not-ready cap ──

test('BUG-07: two free "not ready"s; the third fails the call (counts as an attempt) and HR can allow a retake', async () => {
  await liveCampaign(c, admin, { people: people(1) });
  await ready(tok(1));
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await c.post('/api/candidate/call/start', { token: tok(1) })).status, 200);
    outcomes.push((await c.post('/api/candidate/call/turn', { token: tok(1), form: answerForm('nahi') })).body.outcome);
  }
  assert.deepEqual(outcomes, ['not_ready', 'not_ready', 'not_ready_limit']);
  const cand = store.candidates[0];
  assert.equal(cand.status, 'failed');
  assert.equal(cand.failure_reason, NOT_READY_LIMIT_REASON);
  assert.equal((await c.post('/api/candidate/call/start', { token: tok(1) })).status, 409);
  const me = await c.get('/api/candidate/me', { token: tok(1) });
  assert.equal(me.body.retries_left, 2, 'the capped call used one of three attempts');
});

// ── BUG-04: rate limits ──

test('BUG-04: sign-in and email-code endpoints are rate limited per address and per IP', async () => {
  const login = () => c.post('/api/auth/login', { json: { email: 'victim@qa.test', password: 'guess' } });
  const codes = [];
  for (let i = 0; i < 10; i += 1) codes.push((await login()).status);
  assert.ok(codes.slice(0, 8).every(s => s !== 429));
  assert.equal(codes[8], 429, 'the 9th try for one account within 15 minutes is refused');

  const code = [];
  for (let i = 0; i < 5; i += 1) code.push((await c.post('/api/auth/email-code', { json: { email: 'spam-me@qa.test' } })).status);
  assert.equal(code[3], 429, 'at most 3 codes per email per hour');
});

test('BUG-04: one candidate cannot fire answers in a loop (30 per minute)', async () => {
  await liveCampaign(c, admin, { people: people(1) });
  await ready(tok(1));
  await c.post('/api/candidate/call/start', { token: tok(1) });
  let limited = 0;
  for (let i = 0; i < 34; i += 1) if ((await c.post('/api/candidate/call/turn', { token: tok(1), form: answerForm('') })).status === 429) limited += 1;
  assert.ok(limited >= 4, `${limited} requests refused`);
});

// ── BUG-10 / BUG-08: recordings ──

test('BUG-10: recordings are taken from a temporary file, stored, and the file is deleted afterwards', async () => {
  await liveCampaign(c, admin, { people: people(1) });
  await takeCall(c, tok(1));
  const tmpBefore = fs.readdirSync(os.tmpdir()).length;
  const r = await c.post('/api/candidate/call/recording', { token: tok(1), form: fileForm('recording', Buffer.concat([WEBM_SAMPLE, Buffer.alloc(1024 * 1024)]), 'call.webm', 'audio/webm') });
  assert.equal(r.status, 200);
  const stored = [...store.files.entries()].find(([k]) => k.startsWith('recordings/'))[1];
  assert.equal(stored.bytes, WEBM_SAMPLE.length + 1024 * 1024);
  assert.ok(fs.readdirSync(os.tmpdir()).length <= tmpBefore, 'no temporary file left behind');
});

test('BUG-10: recordings over 20 MB are refused; real OGG and WAV headers are accepted', async () => {
  await liveCampaign(c, admin, { people: people(3) });
  await takeCall(c, tok(1));
  const big = await c.post('/api/candidate/call/recording', { token: tok(1), form: fileForm('recording', Buffer.concat([WEBM_SAMPLE, Buffer.alloc(21 * 1024 * 1024)]), 'call.webm', 'audio/webm') });
  assert.equal(big.status, 400);
  await takeCall(c, tok(2));
  assert.equal((await c.post('/api/candidate/call/recording', { token: tok(2), form: fileForm('recording', Buffer.from('OggS\0\x02qa-ogg'), 'c.ogg', 'audio/ogg') })).status, 200);
  await takeCall(c, tok(3));
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
  assert.equal((await c.post('/api/candidate/call/recording', { token: tok(3), form: fileForm('recording', wav, 'c.wav', 'audio/wav') })).status, 200);
});

// ── BUG-01: invite-link scope ──

test('BUG-01: copy-link works for your own candidates, and an Admin can still copy any', async () => {
  await liveCampaign(c, recA, { people: [{ name: 'Own', email: 'own@qa.test' }] });
  assert.equal((await c.post(`/api/hr/candidates/${store.candidates[0].id}/invite-link`, { token: recA })).status, 200);
  await liveCampaign(c, recB, { name: 'B', people: [{ name: 'Shared', email: 'shared@qa.test' }] });
  await liveCampaign(c, recA, { name: 'A2', people: [{ name: 'Shared', email: 'shared@qa.test' }] });
  const mine = store.candidates.find(x => x.email === 'shared@qa.test' && store.batches.find(b => b.id === x.batch_id).created_by === 'rec-a');
  const refused = await c.post(`/api/hr/candidates/${mine.id}/invite-link`, { token: recA });
  assert.equal(refused.status, 409);
  assert.match(refused.body.message, /Send email/);
  assert.equal((await c.post(`/api/hr/candidates/${mine.id}/invite-link`, { token: admin })).status, 200);
});

// ── BUG-32: exposure ──

test('BUG-32: the app\'s own public address is allowed by CORS; other sites are not', async () => {
  const ok = await c.call('OPTIONS', '/api/hr/batches', { headers: { Origin: 'http://qa.localhost', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'http://qa.localhost');
  const evil = await c.call('OPTIONS', '/api/hr/batches', { headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('BUG-32: every page gets CSP (no inline scripts except the hashed theme switch), an origin-only referrer and frame protection', async () => {
  const page = await c.get('/login');
  const csp = page.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  // Only the origin is sent (Google's sign-in button needs it); the path and ?t= invite token never are.
  assert.equal(page.headers.get('referrer-policy'), 'strict-origin', 'invite tokens in /join?t= never leak to other sites');
  // The only outside script and frame is Google's sign-in button.
  assert.match(csp, /script-src 'self' https:\/\/accounts\.google\.com\/gsi\/client( |;|$)/);
  assert.match(csp, /frame-src https:\/\/accounts\.google\.com\/gsi\/(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*\*/);
  assert.equal(page.headers.get('cross-origin-opener-policy'), 'same-origin-allow-popups');
  assert.match(page.headers.get('permissions-policy'), /microphone=\(self\)/);
  const https = await c.get('/health', { headers: { 'X-Forwarded-Proto': 'https' } });
  assert.match(https.headers.get('strict-transport-security') || '', /max-age=/);
});

test('BUG-32: server errors no longer reveal internals; the app\'s own 4xx messages still reach the user', async () => {
  const db = (await import('../../../backend/src/config/db.js')).default;
  const real = db.listBatches;
  db.listBatches = async () => { throw new Error('relation "batches" does not exist (PGRST205) at postgres://secret-host'); };
  try {
    const r = await c.get('/api/hr/batches', { token: admin });
    assert.equal(r.status, 500);
    assert.doesNotMatch(JSON.stringify(r.body), /PGRST|postgres|relation/);
  } finally { db.listBatches = real; }
  const own = await c.post('/api/hr/batches', { token: admin, json: { name: '', job_role: 'x' } });
  assert.match(own.body.message, /Batch name is required/);
});
