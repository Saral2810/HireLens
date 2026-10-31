// Integration: modifying and deleting campaigns (and correcting candidates) over HTTP.
// Fake DB with storage files, fake SMTP, fake Gnani/LLM — no real services.
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { installFakeDb } from '../helpers/fakeDb.js';
import { installFakeMail, tokenOf } from '../helpers/mail.js';
import { resetNetwork } from '../helpers/network.js';
import { speechRetry, clearAudioCache } from '../../../backend/src/services/gnaniSpeech.js';
import { runningInviteJobs } from '../../../backend/src/services/candidateInvites.js';
import { useTestTransport } from '../../../backend/src/services/mailer.js';
import { startApp, tokens, takeCall, answerForm, fileForm, RESUME_PDF, HAPPY_ANSWERS, WEBM_SAMPLE } from '../helpers/http.js';

let app, store, c, mail;
const admin = tokens.admin();
const recA = tokens.recruiter('rec-a');
const recB = tokens.recruiter('rec-b');
const settle = () => Promise.all([...runningInviteJobs]);
const join = (token) => c.post('/api/auth/join', { json: { token } });

before(async () => { app = await startApp(); c = app.client; });
after(() => app.close());
beforeEach(() => { store = installFakeDb(); resetNetwork(); clearAudioCache(); speechRetry.delaysMs = [1, 1]; mail = installFakeMail(); });
afterEach(() => useTestTransport(null));

async function campaign(token = admin, people = [{ name: 'Asha Rao', email: 'asha@qa.test' }, { name: 'Ravi K', email: 'ravi@qa.test' }], { run = true, name = 'Manage me' } = {}) {
  const batch = (await c.post('/api/hr/batches', { token, json: { name, job_role: 'Backend Engineer', company_name: 'QA Co' } })).body;
  await c.post(`/api/hr/batches/${batch.id}/questions/defaults`, { token });
  await c.post(`/api/hr/batches/${batch.id}/candidates`, { token, json: { candidates: people } });
  if (run) await c.post(`/api/hr/batches/${batch.id}/run`, { token });
  await settle();
  return batch;
}

/** Asha finishes the call and uploads a recording, so the campaign has results and files. */
async function withResults(batch) {
  const asha = tokens.candidate('u-asha', 'asha@qa.test');
  await takeCall(c, asha, HAPPY_ANSWERS);
  await c.post('/api/candidate/call/recording', { token: asha, form: fileForm('recording', WEBM_SAMPLE, 'r.webm', 'audio/webm') });
  return asha;
}

const rowsOf = (batchId) => ({
  questions: store.hr_questions.filter(q => q.batch_id === batchId).length,
  candidates: store.candidates.filter(x => x.batch_id === batchId).length,
  files: [...store.files.keys()].filter(k => k.includes(`/${batchId}/`)).length
});

// ── Delete ──

test('a campaign nobody has started is deleted straight away (draft or live)', async () => {
  const draft = await campaign(admin, undefined, { run: false });
  const r = await c.del(`/api/hr/batches/${draft.id}`, { token: admin });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.deleted, r.body.candidates, r.body.files_removed], [true, 2, 0]);
  assert.deepEqual(rowsOf(draft.id), { questions: 0, candidates: 0, files: 0 });
  assert.equal(store.batches.length, 0);

  const live = await campaign();
  const link = tokenOf(mail.sent[0].link);
  assert.equal((await c.del(`/api/hr/batches/${live.id}`, { token: admin })).status, 200);
  assert.equal((await join(link)).status, 404, 'emailed links stop working');
});

test('once candidates have started, a live campaign must be closed first', async () => {
  const batch = await campaign();
  await withResults(batch);
  const r = await c.del(`/api/hr/batches/${batch.id}`, { token: admin, json: { confirm_name: 'Manage me' } });
  assert.equal(r.status, 409);
  assert.match(r.body.message, /Close the campaign first/);
  assert.equal(store.batches.length, 1);
});

test('with results, deleting needs the exact campaign name; then rows AND resume/recording files are removed', async () => {
  const batch = await campaign();
  await withResults(batch);
  await c.post(`/api/hr/batches/${batch.id}/close`, { token: admin });
  assert.equal(rowsOf(batch.id).files, 2, 'one resume + one recording stored');

  const noName = await c.del(`/api/hr/batches/${batch.id}`, { token: admin });
  assert.equal(noName.status, 400);
  assert.equal(noName.body.code, 'confirm_required');
  assert.equal(noName.body.started, 1);
  assert.equal((await c.del(`/api/hr/batches/${batch.id}`, { token: admin, json: { confirm_name: 'manage me' } })).status, 400, 'name must match exactly');

  const ok = await c.del(`/api/hr/batches/${batch.id}`, { token: admin, json: { confirm_name: '  Manage me ' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.files_removed, 2);
  assert.deepEqual(rowsOf(batch.id), { questions: 0, candidates: 0, files: 0 });
  assert.equal(store.calls.length, 0);
  assert.equal(store.answers.length, 0);
});

test('a candidate still in a call blocks deletion even after the campaign is closed', async () => {
  const batch = await campaign();
  const asha = tokens.candidate('u-asha', 'asha@qa.test');
  await c.post('/api/candidate/resume', { token: asha, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: asha, json: { agree: true } });
  await c.post('/api/candidate/call/start', { token: asha });
  await c.post(`/api/hr/batches/${batch.id}/close`, { token: admin });
  const r = await c.del(`/api/hr/batches/${batch.id}`, { token: admin, json: { confirm_name: 'Manage me' } });
  assert.equal(r.status, 409);
});

test('deleting one campaign leaves every other campaign and its files alone', async () => {
  const keep = await campaign(admin, [{ name: 'Asha Rao', email: 'asha@qa.test' }], { name: 'Keep' });
  await withResults(keep);
  const gone = await campaign(admin, [{ name: 'Other', email: 'other@qa.test' }], { name: 'Gone' });
  const before = rowsOf(keep.id);
  assert.equal((await c.del(`/api/hr/batches/${gone.id}`, { token: admin })).status, 200);
  assert.deepEqual(rowsOf(keep.id), before);
  assert.equal(store.calls.length, 1);
});

test('only the owner (or an Admin) can delete; others get 404, candidates 403', async () => {
  const batch = await campaign(recA);
  assert.equal((await c.del(`/api/hr/batches/${batch.id}`, { token: recB })).status, 404);
  assert.equal((await c.del(`/api/hr/batches/${batch.id}`, { token: tokens.candidate('u', 'asha@qa.test') })).status, 403);
  assert.equal(store.batches.length, 1);
  assert.equal((await c.del(`/api/hr/batches/${batch.id}`, { token: admin })).status, 200);
});

// ── Modify ──

test('campaign details can be edited while live; a call already running keeps its script', async () => {
  const batch = await campaign(admin, [{ name: 'Asha Rao', email: 'asha@qa.test' }]);
  const asha = tokens.candidate('u-asha', 'asha@qa.test');
  await c.post('/api/candidate/resume', { token: asha, form: fileForm('resume', RESUME_PDF, 'r.pdf', 'application/pdf') });
  await c.post('/api/candidate/consent', { token: asha, json: { agree: true } });
  const start = await c.post('/api/candidate/call/start', { token: asha });
  const notice = store.hr_questions.find(q => q.batch_id === batch.id && q.answer_type === 'duration');

  const patch = await c.patch(`/api/hr/batches/${batch.id}`, { token: admin, json: { name: 'Renamed', job_role: 'Platform Engineer', company_name: '', job_description: 'Go and Kubernetes' } });
  assert.equal(patch.status, 200);
  assert.deepEqual([patch.body.name, patch.body.job_role, patch.body.company_name, patch.body.status], ['Renamed', 'Platform Engineer', null, 'live']);
  await c.patch(`/api/hr/questions/${notice.id}`, { token: admin, json: { question_text: 'Notice period kitne din ka hai?' } });

  let last;
  for (const a of HAPPY_ANSWERS) { last = await c.post('/api/candidate/call/turn', { token: asha, form: answerForm(a) }); if (last.body.done) break; }
  assert.equal(last.body.outcome, 'completed');
  assert.ok(store.answers.some(a => a.question_text === 'Aapka current notice period kitna hai?'), 'the running call kept the question it started with');
  assert.match(start.body.lines[0].text, /Backend Engineer/);
});

test('editing validates input and cannot touch protected fields', async () => {
  const batch = await campaign();
  assert.equal((await c.patch(`/api/hr/batches/${batch.id}`, { token: admin, json: { name: '' } })).status, 400);
  assert.equal((await c.patch(`/api/hr/batches/${batch.id}`, { token: admin, json: { batch_date: '2026-02-31' } })).status, 400);
  assert.equal((await c.patch(`/api/hr/batches/${batch.id}`, { token: admin, json: { status: 'draft', created_by: 'x' } })).status, 400, 'nothing editable sent');
  assert.equal((await c.patch(`/api/hr/batches/${batch.id}`, { token: recB, json: { name: 'Hijack' } })).status, 404);
});

test('candidate name can be corrected any time, even after the call', async () => {
  const batch = await campaign();
  await withResults(batch);
  const asha = store.candidates.find(x => x.email === 'asha@qa.test');
  const r = await c.patch(`/api/hr/candidates/${asha.id}`, { token: admin, json: { name: '  Asha   Rao-Iyer ' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.name, 'Asha Rao-Iyer');
  const results = await c.get(`/api/hr/batches/${batch.id}/results`, { token: admin });
  assert.equal(results.body.rows.find(x => x.email === 'asha@qa.test').name, 'Asha Rao-Iyer');
  const email = await c.patch(`/api/hr/candidates/${asha.id}`, { token: admin, json: { email: 'new@qa.test' } });
  assert.equal(email.status, 409, 'the email of someone who already started cannot change');
});

test('a corrected email gets a fresh invite; the link sent to the old address stops working', async () => {
  await campaign(admin, [{ name: 'Typo Person', email: 'typo@qa.tset' }]);
  const cand = store.candidates[0];
  const oldLink = tokenOf(mail.linkFor('typo@qa.tset'));
  await join(oldLink); // someone opened the wrong-address email before HR noticed
  assert.ok(store.candidates[0].user_id);

  const r = await c.patch(`/api/hr/candidates/${cand.id}`, { token: admin, json: { email: 'Right@QA.test' } });
  assert.equal(r.status, 200);
  assert.equal(r.body.email, 'right@qa.test');
  assert.deepEqual(r.body.emails, { configured: true, queued: 1 });
  await settle();
  assert.equal(store.candidates[0].user_id, null, 'the old sign-in is unlinked');

  const old = await join(oldLink);
  assert.equal(old.status, 410);
  assert.match(old.body.message, /replaced/);
  const fresh = await join(tokenOf(mail.linkFor('right@qa.test')));
  assert.equal(fresh.status, 200);
  assert.equal(store.authUsers.find(u => u.id === store.candidates[0].user_id).email, 'right@qa.test');
});

test('candidate edits are validated and scoped to the owner', async () => {
  await campaign(recA, [{ name: 'A', email: 'a@qa.test' }, { name: 'B', email: 'b@qa.test' }], { run: false });
  const [a] = store.candidates;
  assert.equal((await c.patch(`/api/hr/candidates/${a.id}`, { token: recA, json: { email: 'B@qa.test' } })).status, 409, 'already in the campaign');
  assert.equal((await c.patch(`/api/hr/candidates/${a.id}`, { token: recA, json: { email: 'not-an-email' } })).status, 400);
  assert.equal((await c.patch(`/api/hr/candidates/${a.id}`, { token: recA, json: { name: '' } })).status, 400);
  assert.equal((await c.patch(`/api/hr/candidates/${a.id}`, { token: recA, json: { name: 'A' } })).status, 400, 'nothing changed');
  assert.equal((await c.patch(`/api/hr/candidates/${a.id}`, { token: recB, json: { name: 'X' } })).status, 404);
  const draft = await c.patch(`/api/hr/candidates/${a.id}`, { token: recA, json: { email: 'a2@qa.test' } });
  assert.equal(draft.status, 200);
  assert.equal(draft.body.emails.queued, 0, 'draft campaigns email nobody until Run');
  assert.equal(mail.sent.length, 0);
});
