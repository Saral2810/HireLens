// Live end-to-end check of the HR and candidate flows against the real Supabase project and a
// running app (default http://localhost:3000). Creates throwaway accounts and a test batch through
// the app's own invite feature, checks every step, then deletes everything it created.
// Run: node backend/scripts/liveHrCheck.js [baseUrl]
import crypto from 'crypto';
import db from '../src/config/db.js';
import { makeTextPdf } from './makeTextPdf.js';

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
  check('candidate is refused the call-loop test', (await api('POST', '/api/spike/speak', opened.token, { text: 'hi' })).status === 403);
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
