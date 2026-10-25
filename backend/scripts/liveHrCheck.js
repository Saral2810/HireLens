// Live end-to-end check of the HR and candidate flows against the real Supabase project and a
// running app (default http://localhost:3000). Creates throwaway accounts and a test batch through
// the app's own invite feature, checks every step, then deletes everything it created.
// Run: node backend/scripts/liveHrCheck.js [baseUrl]
import crypto from 'crypto';
import db from '../src/config/db.js';
import { makeTextPdf } from './makeTextPdf.js';
import { speak } from '../src/services/gnaniSpeech.js';

const BASE = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const tag = crypto.randomBytes(3).toString('hex');
const createdUserIds = [];
let batchId = null;
let failures = 0;

function check(label, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures += 1;
}

async function api(method, path, token, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, json };
}

/** Follows a one-time sign-in link the way a browser would and returns the session token (or the error). */
async function openLink(actionLink) {
  const res = await fetch(actionLink, { redirect: 'manual' });
  const location = res.headers.get('location') || '';
  const fragment = new URLSearchParams(location.split('#')[1] || '');
  return { token: fragment.get('access_token'), error: fragment.get('error_description') || fragment.get('error'), location };
}

/** Creates a throwaway account through generateLink and signs it in. */
async function throwawaySession(email, role) {
  const { data, error } = await db.supabase.auth.admin.generateLink({ type: 'magiclink', email, options: { redirectTo: `${BASE}/invite` } });
  if (error) throw error;
  createdUserIds.push(data.user.id);
  if (role === 'superadmin') {
    const { error: upErr } = await db.supabase.from('profiles').update({ role: 'superadmin' }).eq('id', data.user.id);
    if (upErr) throw upErr;
  }
  const { token } = await openLink(data.properties.action_link);
  if (!token) throw new Error(`Could not sign in ${email}`);
  return { token, userId: data.user.id };
}

async function run() {
  if (!db.supabase) throw new Error('Supabase is not configured in .env.');
  const health = await api('GET', '/health');
  check('app is running and connected', health.json?.database === 'connected', `${BASE}`);

  // ── HR ──
  const hr = await throwawaySession(`e2e-hr-${tag}@example.com`, 'superadmin');
  const me = await api('GET', '/api/auth/me', hr.token);
  check('HR /auth/me role is superadmin', me.json?.role === 'superadmin', me.json?.role);

  const bad = await api('POST', '/api/hr/batches', hr.token, { name: '', job_role: 'X' });
  check('invalid batch is rejected', bad.status === 400, bad.json?.message);

  const created = await api('POST', '/api/hr/batches', hr.token, { name: `E2E batch ${tag}`, job_role: 'Backend Engineer', company_name: 'Demo Co', batch_date: '2026-10-25' });
  batchId = created.json?.id;
  check('HR creates a batch', created.status === 201 && !!batchId);

  const defaults = await api('POST', `/api/hr/batches/${batchId}/questions/defaults`, hr.token);
  check('default questions added', defaults.json?.added === 5, `added ${defaults.json?.added}`);
  const again = await api('POST', `/api/hr/batches/${batchId}/questions/defaults`, hr.token);
  check('defaults are not added twice', again.json?.added === 0);

  const custom = await api('POST', `/api/hr/batches/${batchId}/questions`, hr.token, { question_text: 'Kya aap hybrid kaam kar sakte hain?', answer_type: 'yes_no' });
  check('custom question added at the end', custom.status === 201 && custom.json?.position === 5, `position ${custom.json?.position}`);

  const ids = (await api('GET', `/api/hr/batches/${batchId}`, hr.token)).json.questions.map(q => q.id);
  const reversed = [...ids].reverse();
  const reordered = await api('PUT', `/api/hr/batches/${batchId}/questions/order`, hr.token, { ids: reversed });
  check('questions reorder', reordered.status === 200 && reordered.json.map(q => q.id).join() === reversed.join());
  const badOrder = await api('PUT', `/api/hr/batches/${batchId}/questions/order`, hr.token, { ids: ids.slice(1) });
  check('incomplete reorder is rejected', badOrder.status === 400);

  const edited = await api('PATCH', `/api/hr/questions/${custom.json.id}`, hr.token, { question_text: 'Kya aap hybrid model mein kaam kar sakte hain?' });
  check('question edited', edited.json?.question_text?.includes('hybrid model'));

  const badRows = await api('POST', `/api/hr/batches/${batchId}/candidates`, hr.token, { candidates: [{ name: 'Ok', email: `ok-${tag}@example.com` }, { name: 'Bad', email: 'nope' }] });
  check('bad candidate rows are reported, nothing saved', badRows.status === 400 && badRows.json?.row_errors?.[0]?.row === 2);

  const emails = [1, 2, 3].map(n => `e2e-cand${n}-${tag}@example.com`);
  const added = await api('POST', `/api/hr/batches/${batchId}/candidates`, hr.token, { candidates: emails.map((email, i) => ({ name: `Test Candidate ${i + 1}`, email })) });
  check('3 candidates added', added.json?.added === 3);
  const dup = await api('POST', `/api/hr/batches/${batchId}/candidates`, hr.token, { candidates: [{ name: 'Again', email: emails[0] }] });
  check('existing email is skipped', dup.json?.added === 0 && dup.json?.skipped_existing === 1);

  const list = (await api('GET', '/api/hr/batches', hr.token)).json.find(b => b.id === batchId);
  check('batch list shows counts', list?.counts?.total === 3 && list?.counts?.invited === 3);

  const detail = (await api('GET', `/api/hr/batches/${batchId}`, hr.token)).json;
  const [cand1, , cand3] = detail.candidates;

  const removed = await api('DELETE', `/api/hr/candidates/${cand3.id}`, hr.token);
  check('invited candidate removed', removed.status === 204);

  // HR's own email must never get a candidate link.
  await api('POST', `/api/hr/batches/${batchId}/candidates`, hr.token, { candidates: [{ name: 'HR person', email: `e2e-hr-${tag}@example.com` }] });
  const hrRow = (await api('GET', `/api/hr/batches/${batchId}`, hr.token)).json.candidates.find(c => c.email === `e2e-hr-${tag}@example.com`);
  const hrLink = await api('POST', `/api/hr/candidates/${hrRow.id}/invite-link`, hr.token);
  check('no invite link for an HR email', hrLink.status === 409, hrLink.json?.message);
  await api('DELETE', `/api/hr/candidates/${hrRow.id}`, hr.token);

  // ── Candidate ──
  const link = await api('POST', `/api/hr/candidates/${cand1.id}/invite-link`, hr.token);
  check('HR gets an invite link', link.status === 200 && /\/auth\/v1\/verify/.test(link.json?.invite_link || ''));
  const { data: candUser } = await db.supabase.from('candidates').select('user_id').eq('id', cand1.id).single();
  if (candUser?.user_id) createdUserIds.push(candUser.user_id);

  const opened = await openLink(link.json.invite_link);
  check('invite link signs the candidate in', !!opened.token && opened.location.startsWith(`${BASE}/invite`), opened.location.split('#')[0]);
  const reused = await openLink(link.json.invite_link);
  check('invite link works only once', !reused.token, reused.error || 'no session');

  const candMe = await api('GET', '/api/auth/me', opened.token);
  check('candidate sees own record and batch',
    candMe.json?.role === 'candidate' && candMe.json?.candidate?.id === cand1.id && candMe.json?.candidate?.batch?.job_role === 'Backend Engineer',
    `${candMe.json?.role}, ${candMe.json?.candidate?.batch?.name}`);
  check('candidate is refused HR pages', (await api('GET', '/api/hr/batches', opened.token)).status === 403);
  check('the old call-loop test is gone', (await api('POST', '/api/spike/speak', hr.token, { text: 'hi' })).status === 404);
  check('HR is refused candidate pages', (await api('GET', '/api/candidate/me', hr.token)).status === 403);

  // ── Candidate: consent and resume (Phase F) ──
  const portal = await api('GET', '/api/candidate/me', opened.token);
  check('candidate portal starts at invited, no resume, no consent',
    portal.json?.status === 'invited' && !portal.json.has_resume && !portal.json.consent_given);
  check('consent must be explicit', (await api('POST', '/api/candidate/consent', opened.token, {})).status === 400);
  const consent = await api('POST', '/api/candidate/consent', opened.token, { agree: true });
  check('consent recorded', consent.json?.consent_given === true && !!consent.json.consent_at);

  const uploadResume = async (bytes, name) => {
    const form = new FormData();
    form.append('resume', new Blob([bytes], { type: 'application/pdf' }), name);
    const res = await fetch(`${BASE}/api/candidate/resume`, { method: 'POST', headers: { Authorization: `Bearer ${opened.token}` }, body: form });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const notPdf = await uploadResume(Buffer.from('this is not a pdf'), 'resume.pdf');
  check('a non-PDF upload is rejected', notPdf.status === 400, notPdf.json?.message);

  const resumePdf = makeTextPdf([
    'Test Candidate 1 - Backend Engineer (made-up resume for testing)',
    'Experience: 3 years at Example Logistics (Java, Spring Boot, MySQL)',
    'Built a shipment tracking API used by 40 warehouses',
    'Reduced report generation time from 2 hours to 10 minutes with batch jobs',
    'Project: chatbot for delivery status using Python and Dialogflow',
    'Skills: Java, Spring Boot, MySQL, Python, REST APIs, Docker'
  ]);
  const uploaded = await uploadResume(resumePdf, 'resume.pdf');
  check('resume uploaded and questions written from it',
    uploaded.status === 200 && uploaded.json?.readable && uploaded.json?.questions_from === 'resume'
      && uploaded.json.questions_ready >= 3 && uploaded.json.questions_ready <= 5,
    `${uploaded.json?.questions_ready} questions from ${uploaded.json?.questions_from}`);

  const { data: row } = await db.supabase.from('candidates').select('status, resume_path, resume_questions, resume_text').eq('id', cand1.id).single();
  check('database: status resume_uploaded, resume stored', row?.status === 'resume_uploaded' && row.resume_path === `${batchId}/${cand1.id}.pdf` && /shipment tracking/.test(row.resume_text || ''));
  console.log('      resume questions:\n' + (row?.resume_questions || []).map((q, i) => `        ${i + 1}. ${q.question_text}`).join('\n'));
  const { data: files } = await db.supabase.storage.from('resumes').list(batchId);
  check('PDF saved in private storage', files?.some(f => f.name === `${cand1.id}.pdf`));

  const after = await api('GET', '/api/candidate/me', opened.token);
  check('candidate sees resume and consent done, questions not exposed',
    after.json?.has_resume && after.json.consent_given && after.json.status === 'resume_uploaded' && !('resume_questions' in after.json));
  check('HR cannot remove a candidate who has started', (await api('DELETE', `/api/hr/candidates/${cand1.id}`, hr.token)).status === 409);
  check('HR cannot delete a batch with started candidates', (await api('DELETE', `/api/hr/batches/${batchId}`, hr.token)).status === 409);

  const bulk = await api('POST', `/api/hr/batches/${batchId}/invite-links`, hr.token);
  check('bulk invite links for everyone not finished', bulk.json?.links?.length === 2 && bulk.json.links.every(l => l.invite_link));
  for (const l of bulk.json?.links || []) {
    const { data } = await db.supabase.from('candidates').select('user_id').eq('id', l.candidate_id).single();
    if (data?.user_id && !createdUserIds.includes(data.user_id)) createdUserIds.push(data.user_id);
  }

  const malformed = await api('GET', '/api/hr/batches/not-a-uuid', hr.token);
  check('malformed id is a clean 404', malformed.status === 404);

  await screeningCall(opened.token, cand1.id);
  await hrResults(hr.token, cand1.id, bulk.json.links.find(l => l.candidate_id !== cand1.id));
}

// ── Screening call (Phase G) ──
// Answers are spoken by Timbre as 16 kHz WAV and sent like the browser does, so this uses a few
// Prisma, Timbre and LLM credits (about 12 turns).

/** A made-up spoken answer that fits the question. */
function answerFor(q) {
  const text = q.question_text.toLowerCase();
  if (q.source === 'intro') return 'Haan, main ready hoon.';
  if (q.answer_type === 'duration') return 'Mera notice period do mahine ka hai.';
  if (q.answer_type === 'ctc') return text.includes('expected') ? 'Meri expected CTC baarah lakh hai.' : 'Meri current CTC nau lakh hai.';
  if (q.answer_type === 'yes_no') return 'Haan, bilkul kar sakta hoon.';
  if (text.includes('city')) return 'Main Pune mein hoon, aur Bangalore relocate kar sakta hoon.';
  if (text.includes('join')) return 'Notice period ke baad, lagbhag do mahine mein join kar sakta hoon.';
  return 'Maine Java aur Spring Boot mein shipment tracking API banaya tha, jo chaalis warehouses use karte the.';
}

async function sendTurn(token, wav) {
  const form = new FormData();
  if (wav) form.append('audio', new Blob([wav], { type: 'audio/wav' }), 'answer.wav');
  else form.append('no_speech', '1');
  const res = await fetch(`${BASE}/api/candidate/call/turn`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function screeningCall(token, candidateId) {
  const say = async (text) => (await speak(text, { container: 'wav', sampleRate: 16000 })).audio;

  // Not ready → the call ends politely and the candidate can start again.
  const first = await api('POST', '/api/candidate/call/start', token);
  check('call starts with intro and first question as audio',
    first.status === 200 && first.json?.lines?.length === 2 && first.json.lines.every(l => l.audio_base64?.length > 1000),
    `${first.json?.total_questions} questions`);
  check('a second start while in a call is refused', (await api('POST', '/api/candidate/call/start', token)).status === 409);
  const notReady = await sendTurn(token, await say('Nahi, abhi main busy hoon, baad mein baat karte hain.'));
  check('"not ready" ends the call politely', notReady.json?.done === true && notReady.json.outcome === 'not_ready', notReady.json?.heard);
  const back = await api('GET', '/api/candidate/me', token);
  check('candidate can start again after "not ready"', back.json?.status === 'resume_uploaded');

  // The real call.
  const start = await api('POST', '/api/candidate/call/start', token);
  check('second call starts', start.status === 200, start.json?.message);
  const callId = start.json?.call_id;
  const { data: call } = await db.supabase.from('calls').select('question_plan').eq('id', callId).single();
  const plan = call.question_plan.questions;

  let position = start.json.position;
  let triedSilence = false;
  let turns = 0;
  const gaps = [];
  let last = null;
  while (turns < 30) {
    turns += 1;
    const q = plan.find(p => p.position === position);
    // Once, send silence on a resume question to check the repeat path.
    const silent = !triedSilence && q.source === 'resume';
    if (silent) triedSilence = true;
    last = await sendTurn(token, silent ? null : await say(answerFor(q)));
    if (last.status !== 200) break;
    gaps.push(last.json.timings.total_ms);
    if (silent) check('silence gets the question repeated', last.json.decision === 'repeat' && last.json.position === position, last.json.lines?.[0]?.text);
    console.log(`      [${q.source}/${q.answer_type}] heard "${last.json.heard}" → ${last.json.decision} (${last.json.timings.total_ms} ms)`);
    if (last.json.done) break;
    position = last.json.position;
  }
  check('call reaches the closing line', last?.json?.done === true && last.json.outcome === 'completed', last?.json?.message);
  console.log(`      server time per turn: avg ${Math.round(gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1))} ms, max ${Math.max(...gaps)} ms`);
  check('a turn after the call is refused', (await sendTurn(token, null)).status === 409);

  const recording = await fetch(`${BASE}/api/candidate/call/recording`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    body: (() => { const f = new FormData(); f.append('recording', new Blob([Buffer.alloc(4096, 1)], { type: 'audio/webm;codecs=opus' }), 'call.webm'); return f; })()
  });
  check('recording uploaded after the call', recording.status === 200);

  // Summary is written in the background.
  let saved = null;
  for (let i = 0; i < 20; i += 1) {
    ({ data: saved } = await db.supabase.from('calls').select('*').eq('id', callId).single());
    if (saved?.summary) break;
    await new Promise(r => setTimeout(r, 500));
  }
  const { data: answers } = await db.supabase.from('answers').select('*').eq('call_id', callId).order('position');
  const { data: cand } = await db.supabase.from('candidates').select('status').eq('id', candidateId).single();
  check('database: call completed with transcript and recording',
    saved?.status === 'completed' && !!saved.ended_at && saved.transcript.length >= plan.length * 2 && saved.recording_path?.endsWith('.webm'));
  check('database: one answer row per question', answers?.length === plan.length, `${answers?.length} of ${plan.length}`);
  const byType = (type) => answers.filter(a => a.answer_type === type).map(a => a.extracted_value);
  check('notice period extracted as 60 days', byType('duration').some(v => v?.days === 60), JSON.stringify(byType('duration')));
  check('CTC extracted as 9 and 12 LPA', JSON.stringify(byType('ctc').map(v => v?.lpa).sort((a, b) => a - b)) === '[9,12]', JSON.stringify(byType('ctc')));
  check('candidate marked completed', cand?.status === 'completed');
  check('summary and fit score written', !!saved?.summary && Number.isInteger(saved.fit_score), `${saved?.fit_score}: ${saved?.summary}`);
  check('a second start after completion is refused', (await api('POST', '/api/candidate/call/start', token)).status === 409);
}


async function cleanup() {
  if (batchId) {
    // Storage files are not removed by the database cascade.
    for (const bucket of ['resumes', 'recordings']) {
      const { data: files } = await db.supabase.storage.from(bucket).list(batchId);
      if (files?.length) {
        const { error } = await db.supabase.storage.from(bucket).remove(files.map(f => `${batchId}/${f.name}`));
        console.log(error ? `cleanup: ${bucket} delete failed: ${error.message}` : `cleanup: ${files.length} file(s) removed from ${bucket}`);
      }
    }
    const { error } = await db.supabase.from('batches').delete().eq('id', batchId);
    console.log(error ? `cleanup: batch delete failed: ${error.message}` : 'cleanup: test batch deleted (questions and candidates cascade)');
  }
  for (const id of new Set(createdUserIds)) {
    const { error } = await db.supabase.auth.admin.deleteUser(id);
    if (error) console.log(`cleanup: could not delete user ${id}: ${error.message}`);
  }
  const { count } = await db.supabase.from('profiles').select('id', { count: 'exact', head: true }).like('email', `e2e-%-${tag}@example.com`);
  console.log(`cleanup: ${new Set(createdUserIds).size} test accounts deleted; leftover test profiles: ${count}`);
}

try {
  await run();
} catch (err) {
  failures += 1;
  console.log(`FAIL  stopped early: ${err.message}`);
} finally {
  await cleanup();
  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}

// ── HR results, export and retake (Phase H) ──

async function hrResults(hrToken, cand1Id, otherLink) {
  const results = await api('GET', `/api/hr/batches/${batchId}/results`, hrToken);
  const row = results.json?.rows?.find(r => r.candidate_id === cand1Id);
  check('results row has notice, CTC, score and summary',
    row?.status === 'completed' && row.notice_period_days === 60 && row.current_ctc_lpa === 9 && row.expected_ctc_lpa === 12
      && Number.isInteger(row.call?.fit_score) && !!row.call?.summary && row.call.has_recording,
    `${row?.notice_period_days} days, ${row?.current_ctc_lpa} → ${row?.expected_ctc_lpa} LPA, score ${row?.call?.fit_score}`);
  check('results list every candidate', results.json?.rows?.length === 2);

  const detail = await api('GET', `/api/hr/calls/${row.call.id}`, hrToken);
  check('call detail has answers, transcript and signed links',
    detail.json?.answers?.length >= 8 && detail.json.transcript.length > 10 && /token=/.test(detail.json.recording_url || '') && !!detail.json.resume_url
      && detail.json.links_expire_in_seconds === 600);
  const audio = await fetch(detail.json.recording_url);
  check('recording link downloads the file', audio.ok && (await audio.arrayBuffer()).byteLength === 4096);

  const download = async (format) => {
    const res = await fetch(`${BASE}/api/hr/batches/${batchId}/export?format=${format}`, { headers: { Authorization: `Bearer ${hrToken}` } });
    return { status: res.status, type: res.headers.get('content-type') || '', name: res.headers.get('content-disposition') || '', body: Buffer.from(await res.arrayBuffer()) };
  };
  const csv = await download('csv');
  const text = csv.body.toString('utf8');
  check('CSV export downloads with headers and the candidate',
    csv.status === 200 && /text\/csv/.test(csv.type) && /\.csv"/.test(csv.name) && text.includes('Notice period (days)') && text.includes('Test Candidate 1') && text.includes('60 days'));
  const xlsx = await download('xlsx');
  check('Excel export is a real .xlsx file', xlsx.status === 200 && /spreadsheetml/.test(xlsx.type) && xlsx.body.subarray(0, 2).toString() === 'PK', `${xlsx.body.length} bytes`);

  check('a completed candidate cannot be given a retake', (await api('POST', `/api/hr/candidates/${cand1Id}/allow-retake`, hrToken)).status === 409);

  // Second candidate: start a call, end it, then HR allows a retake.
  const opened = await openLink(otherLink.invite_link);
  const { data: u } = await db.supabase.from('candidates').select('user_id').eq('id', otherLink.candidate_id).single();
  if (u?.user_id && !createdUserIds.includes(u.user_id)) createdUserIds.push(u.user_id);
  await api('POST', '/api/candidate/consent', opened.token, { agree: true });
  const form = new FormData();
  form.append('resume', new Blob([makeTextPdf(['Test Candidate 2 (made-up)', 'Fresher, B.Tech 2026', 'Project: weather app in React'])], { type: 'application/pdf' }), 'resume.pdf');
  await fetch(`${BASE}/api/candidate/resume`, { method: 'POST', headers: { Authorization: `Bearer ${opened.token}` }, body: form });
  const startAndStop = async (reason) => {
    const started = await api('POST', '/api/candidate/call/start', opened.token);
    const ended = await api('POST', '/api/candidate/call/end', opened.token, { reason });
    return { started: started.status, ended: ended.json?.ended, me: (await api('GET', '/api/candidate/me', opened.token)).json };
  };
  const first = await startAndStop('client_error');
  check('a call that stops part-way marks the candidate failed, with 2 tries left',
    first.started === 200 && first.ended === true && first.me?.status === 'failed' && first.me.retries_left === 2 && /technical problem/.test(first.me.failure_reason || ''),
    `${first.me?.retries_left} left: ${first.me?.failure_reason}`);
  const selfRetry = await api('POST', '/api/candidate/call/retry', opened.token);
  check('the candidate can retry on their own', selfRetry.status === 200 && selfRetry.json?.status === 'resume_uploaded' && selfRetry.json.retries_left === 1);
  check('retry is refused when nothing has stopped', (await api('POST', '/api/candidate/call/retry', opened.token)).status === 409);
  await startAndStop('left_page');
  await api('POST', '/api/candidate/call/retry', opened.token);
  const third = await startAndStop('ended_by_candidate');
  const noMore = await api('POST', '/api/candidate/call/retry', opened.token);
  check('after 3 calls the candidate must ask HR', third.me?.retries_left === 0 && noMore.status === 409, noMore.json?.message);

  const retake = await api('POST', `/api/hr/candidates/${otherLink.candidate_id}/allow-retake`, hrToken);
  const again = await api('GET', '/api/candidate/me', opened.token);
  check('HR retake still lets the candidate start again', retake.status === 200 && again.json?.status === 'resume_uploaded', retake.json?.status);
  const after = (await api('GET', `/api/hr/batches/${batchId}/results`, hrToken)).json.rows.find(r => r.candidate_id === otherLink.candidate_id);
  check('results keep every earlier attempt', after?.attempts === 3 && after.call?.status === 'failed', `${after?.attempts} attempts`);
}
