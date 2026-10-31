// Integration: HR features over HTTP — campaigns, questions, candidates, run/close, results, export,
// team, and role-based access (Admin vs Recruiter vs Candidate). Fake DB; no network beyond localhost.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { installFakeDb } from '../helpers/fakeDb.js';
import { resetNetwork } from '../helpers/network.js';
import { speechRetry, clearAudioCache } from '../../../backend/src/services/gnaniSpeech.js';
import { startApp, tokens, liveCampaign, takeCall, fileForm } from '../helpers/http.js';

let app, store, c;
const admin = tokens.admin();
const recA = tokens.recruiter('rec-a');
const recB = tokens.recruiter('rec-b');

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => { store = installFakeDb(); resetNetwork(); clearAudioCache(); speechRetry.delaysMs = [1, 1]; });

const people = (n, prefix = 'p') => Array.from({ length: n }, (_, i) => ({ name: `Person ${i + 1}`, email: `${prefix}${i + 1}@qa.test` }));

// ── Campaign CRUD and validation ──

test('create campaign: required fields, length limits and dates are validated', async () => {
  assert.equal((await c.post('/api/hr/batches', { token: admin, json: { name: '', job_role: 'X' } })).status, 400);
  assert.equal((await c.post('/api/hr/batches', { token: admin, json: { name: 'A'.repeat(121), job_role: 'X' } })).status, 400);
  assert.equal((await c.post('/api/hr/batches', { token: admin, json: { name: 'A', job_role: 'X', batch_date: '2026-02-30' } })).status, 400);
  const ok = await c.post('/api/hr/batches', { token: admin, json: { name: 'Backend hiring', job_role: 'Backend Engineer' } });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.status, 'draft');
  assert.equal(ok.body.created_by, 'admin-1');
});

test('PATCH cannot change owner, status or other protected columns (mass assignment)', async () => {
  const b = (await c.post('/api/hr/batches', { token: recA, json: { name: 'Mine', job_role: 'QA' } })).body;
  const r = await c.patch(`/api/hr/batches/${b.id}`, { token: recA, json: { name: 'Renamed', created_by: 'rec-b', status: 'live', launched_at: '2020-01-01' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Renamed');
  assert.equal(r.body.created_by, 'rec-a');
  assert.equal(r.body.status, 'draft');
});

test('run needs at least one candidate; close and reopen work', async () => {
  const b = (await c.post('/api/hr/batches', { token: admin, json: { name: 'C', job_role: 'R' } })).body;
  assert.equal((await c.post(`/api/hr/batches/${b.id}/run`, { token: admin })).status, 400);
  await c.post(`/api/hr/batches/${b.id}/candidates`, { token: admin, json: { candidates: people(1) } });
  assert.equal((await c.post(`/api/hr/batches/${b.id}/run`, { token: admin })).body.status, 'live');
  assert.equal((await c.post(`/api/hr/batches/${b.id}/close`, { token: admin })).body.status, 'closed');
  assert.equal((await c.post(`/api/hr/batches/${b.id}/run`, { token: admin })).body.status, 'live');
});

test('a campaign cannot be deleted once a candidate has started', async () => {
  const { batch } = await liveCampaign(c, admin, { people: [{ name: 'Asha', email: 'asha@qa.test' }] });
  await c.post('/api/candidate/resume', { token: tokens.candidate('u1', 'asha@qa.test'), form: fileForm('resume', (await import('../helpers/http.js')).RESUME_PDF, 'r.pdf', 'application/pdf') });
  assert.equal((await c.del(`/api/hr/batches/${batch.id}`, { token: admin })).status, 409);
});

// ── Questions ──

test('questions: defaults, add, edit, validation, reorder, delete', async () => {
  const b = (await c.post('/api/hr/batches', { token: admin, json: { name: 'Q', job_role: 'R' } })).body;
  const d = await c.post(`/api/hr/batches/${b.id}/questions/defaults`, { token: admin });
  assert.equal(d.body.added, 5);
  assert.equal((await c.post(`/api/hr/batches/${b.id}/questions/defaults`, { token: admin })).body.added, 0, 'defaults are not added twice');
  assert.equal((await c.post(`/api/hr/batches/${b.id}/questions`, { token: admin, json: { question_text: 'Hi', answer_type: 'text' } })).status, 400);
  assert.equal((await c.post(`/api/hr/batches/${b.id}/questions`, { token: admin, json: { question_text: 'Years of experience?', answer_type: 'salary' } })).status, 400);
  const q = await c.post(`/api/hr/batches/${b.id}/questions`, { token: admin, json: { question_text: 'Kitne saal ka experience hai?', answer_type: 'number' } });
  assert.equal(q.status, 201);
  assert.equal(q.body.position, 5);
  const ids = d.body.questions.map(x => x.id).reverse().concat(q.body.id);
  assert.equal((await c.put(`/api/hr/batches/${b.id}/questions/order`, { token: admin, json: { ids: ids.slice(1) } })).status, 400, 'reorder must list every question');
  const re = await c.put(`/api/hr/batches/${b.id}/questions/order`, { token: admin, json: { ids } });
  assert.deepEqual(re.body.map(x => x.id), ids);
  assert.equal((await c.del(`/api/hr/questions/${q.body.id}`, { token: admin })).status, 204);
});

test('BUG-17: two questions added at the same moment collide on position and one request fails with 500', { todo: 'BUG-17 addQuestions read-then-insert race' }, async () => {
  store = installFakeDb({ latencyMs: 20 }); // real Supabase round trips are 50–100 ms, so requests overlap
  const b = (await c.post('/api/hr/batches', { token: admin, json: { name: 'Q', job_role: 'R' } })).body;
  const [x, y] = await Promise.all([
    c.post(`/api/hr/batches/${b.id}/questions`, { token: admin, json: { question_text: 'Question one here?', answer_type: 'text' } }),
    c.post(`/api/hr/batches/${b.id}/questions`, { token: admin, json: { question_text: 'Question two here?', answer_type: 'text' } })
  ]);
  assert.deepEqual([x.status, y.status], [201, 201]);
});

// ── Candidates ──

test('candidates: bad rows are reported, duplicates skipped, max 100 per campaign', async () => {
  const b = (await c.post('/api/hr/batches', { token: admin, json: { name: 'Cands', job_role: 'R' } })).body;
  const bad = await c.post(`/api/hr/batches/${b.id}/candidates`, { token: admin, json: { candidates: [{ name: 'A', email: 'nope' }, { name: '', email: 'x@y.co' }] } });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.row_errors.length, 2);
  const dup = await c.post(`/api/hr/batches/${b.id}/candidates`, { token: admin, json: { candidates: [{ name: 'A', email: 'A@QA.test' }, { name: 'B', email: 'a@qa.test' }] } });
  assert.equal(dup.status, 400, 'repeat inside one upload is an error');
  assert.equal((await c.post(`/api/hr/batches/${b.id}/candidates`, { token: admin, json: { candidates: people(100) } })).body.added, 100);
  const over = await c.post(`/api/hr/batches/${b.id}/candidates`, { token: admin, json: { candidates: [{ name: 'X', email: 'x101@qa.test' }] } });
  assert.equal(over.status, 400);
});

test('BUG-18: two uploads at the same time can push a campaign past the 100-candidate cap', { todo: 'BUG-18 count-then-insert race on the cap' }, async () => {
  store = installFakeDb({ latencyMs: 20 });
  const b = (await c.post('/api/hr/batches', { token: admin, json: { name: 'Cap', job_role: 'R' } })).body;
  await Promise.all([
    c.post(`/api/hr/batches/${b.id}/candidates`, { token: admin, json: { candidates: people(60, 'a') } }),
    c.post(`/api/hr/batches/${b.id}/candidates`, { token: admin, json: { candidates: people(60, 'b') } })
  ]);
  assert.ok(store.candidates.length <= 100, `campaign holds ${store.candidates.length} candidates`);
});

test('spreadsheet import reads CSV and XLSX, rejects other files and oversize uploads', async () => {
  const csv = await c.post('/api/hr/parse-candidates', { token: admin, form: fileForm('file', Buffer.from('Name,Email\nAsha,ASHA@qa.test\n'), 'c.csv', 'text/csv') });
  assert.deepEqual(csv.body.rows, [{ name: 'Asha', email: 'asha@qa.test' }]);
  const book = new ExcelJS.Workbook();
  const s = book.addWorksheet('S');
  s.addRow(['Full Name', 'E-mail']); s.addRow(['Ravi', 'ravi@qa.test']);
  const xlsx = await c.post('/api/hr/parse-candidates', { token: admin, form: fileForm('file', Buffer.from(await book.xlsx.writeBuffer()), 'c.xlsx', 'application/octet-stream') });
  assert.deepEqual(xlsx.body.rows, [{ name: 'Ravi', email: 'ravi@qa.test' }]);
  assert.equal((await c.post('/api/hr/parse-candidates', { token: admin, form: fileForm('file', Buffer.from('x'), 'c.pdf', 'application/pdf') })).status, 400);
  assert.equal((await c.post('/api/hr/parse-candidates', { token: admin, form: fileForm('file', Buffer.alloc(2 * 1024 * 1024 + 10, 65), 'c.csv', 'text/csv') })).status, 400);
  assert.equal((await c.post('/api/hr/parse-candidates', { token: admin, form: fileForm('file', Buffer.from('PK broken'), 'c.xlsx', 'application/octet-stream') })).status, 400);
});

// ── Role-based access ──

test('recruiters only reach their own campaigns (and everything under them); others get 404', async () => {
  const { batch } = await liveCampaign(c, recA, { people: [{ name: 'Asha', email: 'asha@qa.test' }] });
  await takeCall(c, tokens.candidate('u1', 'asha@qa.test'));
  const cand = store.candidates[0];
  const call = store.calls[0];
  const q = store.hr_questions[0];
  for (const [m, p] of [
    ['get', `/api/hr/batches/${batch.id}`], ['patch', `/api/hr/batches/${batch.id}`], ['del', `/api/hr/batches/${batch.id}`],
    ['get', `/api/hr/batches/${batch.id}/results`], ['get', `/api/hr/batches/${batch.id}/export`], ['post', `/api/hr/batches/${batch.id}/close`],
    ['patch', `/api/hr/questions/${q.id}`], ['del', `/api/hr/questions/${q.id}`],
    ['post', `/api/hr/candidates/${cand.id}/invite-link`], ['post', `/api/hr/candidates/${cand.id}/allow-retake`], ['del', `/api/hr/candidates/${cand.id}`],
    ['get', `/api/hr/calls/${call.id}`]
  ]) {
    const r = await c[m](p, { token: recB, json: m === 'patch' ? { name: 'x', question_text: 'hijack?' } : undefined });
    assert.equal(r.status, 404, `${m.toUpperCase()} ${p} → ${r.status}`);
  }
  assert.equal((await c.get('/api/hr/batches', { token: recB })).body.length, 0);
  assert.equal((await c.get(`/api/hr/batches/${batch.id}`, { token: admin })).status, 200, 'Admin sees every campaign');
  assert.equal((await c.get('/api/hr/analytics', { token: recB })).body.campaigns.total, 0);
});

test('candidates cannot use any HR endpoint; HR cannot use candidate endpoints', async () => {
  const cand = tokens.candidate('u1', 'asha@qa.test');
  for (const p of ['/api/hr/batches', '/api/hr/analytics', '/api/hr/team']) assert.equal((await c.get(p, { token: cand })).status, 403, p);
  assert.equal((await c.get('/api/candidate/me', { token: admin })).status, 403);
  assert.equal((await c.post('/api/candidate/call/start', { token: recA })).status, 403);
});

test('team management is Admin-only; Admin cannot change or delete themselves', async () => {
  assert.equal((await c.get('/api/hr/team', { token: recA })).status, 403);
  assert.equal((await c.post('/api/hr/team', { token: recA, json: { name: 'X', email: 'x@qa.test', password: 'password1', role: 'superadmin' } })).status, 403);
  const created = await c.post('/api/hr/team', { token: admin, json: { name: 'Neha', email: 'neha@qa.test', password: 'password1' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.role, 'recruiter');
  assert.equal((await c.post('/api/hr/team', { token: admin, json: { name: 'N', email: 'neha@qa.test', password: 'password1' } })).status, 409);
  assert.equal((await c.post('/api/hr/team', { token: admin, json: { name: 'N', email: 'short@qa.test', password: 'short' } })).status, 400);
  const adminId = '00000000-0000-4000-8000-0000000000aa';
  const self = tokens.admin(adminId);
  assert.equal((await c.patch(`/api/hr/team/${adminId}`, { token: self, json: { role: 'recruiter' } })).status, 400);
  assert.equal((await c.del(`/api/hr/team/${adminId}`, { token: self })).status, 400);
  assert.equal((await c.del(`/api/hr/team/${created.body.id}`, { token: self })).status, 204);
});

test('BUG-33: HR passwords only need 8 characters ("password" and "12345678" are accepted)', { todo: 'BUG-33 weak HR password policy' }, async () => {
  const r = await c.post('/api/hr/team', { token: admin, json: { name: 'Weak', email: 'weak@qa.test', password: '12345678' } });
  assert.equal(r.status, 400);
});

// ── Invite links ──

test('invite links are refused for Admin and Recruiter emails (prevents HR account takeover)', async () => {
  store.addProfile({ id: 'rec-x', email: 'recx@qa.test', role: 'recruiter' });
  store.addProfile({ id: 'adm-x', email: 'admx@qa.test', role: 'superadmin' });
  const { batch } = await liveCampaign(c, recA, { people: [{ name: 'R', email: 'recx@qa.test' }, { name: 'A', email: 'admx@qa.test' }] });
  for (const cand of store.candidates.filter(x => x.batch_id === batch.id)) {
    assert.equal((await c.post(`/api/hr/candidates/${cand.id}/invite-link`, { token: recA })).status, 409, cand.email);
  }
});

test('BUG-01 (fixed 27 Oct): a recruiter can mint a sign-in link for a candidate who belongs to ANOTHER recruiter and act as them', async () => {
  // Recruiter B's candidate signs up normally.
  await liveCampaign(c, recB, { people: [{ name: 'Victim', email: 'victim@qa.test' }] });
  await c.post(`/api/hr/candidates/${store.candidates[0].id}/invite-link`, { token: recB });
  const victimUserId = store.candidates[0].user_id;
  // Recruiter A adds the same email to their own campaign and mints a link.
  await liveCampaign(c, recA, { name: 'Attacker campaign', people: [{ name: 'Victim', email: 'victim@qa.test' }] });
  const mine = store.candidates.find(x => x.batch_id === store.batches[1].id);
  const r = await c.post(`/api/hr/candidates/${mine.id}/invite-link`, { token: recA });
  // The link signs in as the SAME auth user that owns Recruiter B's screening.
  const linkedTo = store.candidates.find(x => x.id === mine.id).user_id;
  assert.ok(r.status !== 200 || linkedTo !== victimUserId, 'link should not sign in as an account that has screenings in someone else\'s campaign');
});

// ── Results and export ──

test('results and CSV/XLSX export contain the extracted values; bad format is refused', async () => {
  const { batch } = await liveCampaign(c, admin, { people: [{ name: '=HYPERLINK("http://evil")', email: 'asha@qa.test' }] });
  await takeCall(c, tokens.candidate('u1', 'asha@qa.test'));
  const csv = await c.get(`/api/hr/batches/${batch.id}/export?format=csv`, { token: admin });
  assert.equal(csv.status, 200);
  assert.match(csv.body, /'=HYPERLINK/, 'formula is neutralised with a leading quote');
  assert.match(csv.body, /,60,9,12,/);
  const xlsx = await c.get(`/api/hr/batches/${batch.id}/export?format=xlsx`, { token: admin });
  assert.equal(xlsx.status, 200);
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(xlsx.body);
  const row = book.worksheets[0].getRow(2).values;
  assert.equal(row[6], 60);
  assert.equal((await c.get(`/api/hr/batches/${batch.id}/export?format=pdf`, { token: admin })).status, 400);
  const detail = await c.get(`/api/hr/calls/${store.calls[0].id}`, { token: admin });
  assert.equal(detail.body.links_expire_in_seconds, 600);
  assert.ok(detail.body.transcript.length > 10);
});

test('analytics counts campaigns, candidates and completed calls for the viewer only', async () => {
  await liveCampaign(c, recA, { people: people(3, 'a') });
  await liveCampaign(c, recB, { people: people(2, 'b') });
  const a = await c.get('/api/hr/analytics', { token: recA });
  const all = await c.get('/api/hr/analytics', { token: admin });
  assert.equal(a.body.campaigns.total, 1);
  assert.equal(all.body.campaigns.total, 2);
});
