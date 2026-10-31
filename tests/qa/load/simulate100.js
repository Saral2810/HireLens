// 100-candidate load simulation — uses NO Gnani or LLM credits.
//
// The real app runs in a child process (tests/qa/load/server.js) with the in-memory DB and the fake
// Gnani/LLM from tests/qa/helpers. Every external latency is the real-world figure divided by SCALE,
// and every measured time below is multiplied back by SCALE, so results read as real-world seconds.
//
//   npm run qa:load                     both scenarios
//   QA_SCENARIO=burst npm run qa:load   one scenario
//
// Scenario "burst":  HR runs a 100-person campaign and all 100 open the link within 1 minute.
// Scenario "steady": the same 100 people arrive evenly over 20 minutes.
// Scenario "email":  running the campaign emails all 100 their personal link; all 100 open it within a minute.
import { fork } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeTextPdf } from '../../../backend/scripts/makeTextPdf.js';
import { sayClip } from '../helpers/network.js';

const SCALE = Number(process.env.QA_SCALE || 10);
const here = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.join(here, '..', 'reports');
const ADMIN = 'Bearer test:superadmin:00000000-0000-4000-8000-0000000000aa:admin@qa.test';
const sleep = (realMs) => new Promise(r => setTimeout(r, realMs / SCALE));

let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);

const ANSWERS = [
  'haan ready hoon', 'Maine payments reconciliation service banayi thi', 'Main tech lead tha', 'PostgreSQL pasand hai',
  'Kafka consumer lag fix kiya tha', '60 days', '9 lakh', '12 lakh', 'Pune, relocate kar sakta hoon', 'Do mahine mein'
];
const RESUME = makeTextPdf([
  'Made-up candidate resume for the QA load test', 'Experience: 3 years building Node.js APIs and PostgreSQL schemas',
  'Built an order tracking service handling fifty thousand requests per minute', 'Skills: Node.js, TypeScript, PostgreSQL, Redis, Docker, AWS, Kafka',
  'Education: B.Tech Computer Science, 2021. Projects: chat app, analytics dashboard, CI pipeline automation'
]);

function pickBehaviour() {
  const r = rand();
  if (r < 0.75) return 'normal';
  if (r < 0.83) return 'not_ready_first';
  if (r < 0.88) return 'silent_twice';
  if (r < 0.92) return 'double_submit';
  if (r < 0.96) return 'abandon_tab';
  return 'end_early';
}

function startServer(extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(path.join(here, 'server.js'), [], {
      execArgv: ['--import', './tests/qa/setup.js'], env: { ...process.env, QA_SCALE: String(SCALE), ...extraEnv }, stdio: ['ignore', 'ignore', 'inherit', 'ipc']
    });
    const waiters = [];
    child.on('message', (m) => {
      if (m.type === 'ready') resolve({ child, base: `http://127.0.0.1:${m.port}`, stats: () => new Promise(r => { waiters.push(r); child.send('stats'); }) });
      if (m.type === 'stats') waiters.shift()?.(m);
    });
    child.on('error', reject);
  });
}

function client(base) {
  const metrics = [];
  async function call(kind, method, p, token, { json, form } = {}) {
    const started = Date.now();
    const init = { method, headers: { Authorization: token } };
    if (json) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
    if (form) init.body = form;
    let status = 0;
    let body = null;
    try {
      const res = await fetch(base + p, init);
      status = res.status;
      body = await res.json().catch(() => null);
    } catch (err) { body = { error: err.message }; }
    const realMs = (Date.now() - started) * SCALE;
    metrics.push({ kind, status, realMs });
    return { status, body, realMs };
  }
  return { call, metrics };
}

const form = (field, buf, name, type, extra = {}) => { const f = new FormData(); f.append(field, new Blob([buf], { type }), name); for (const [k, v] of Object.entries(extra)) f.append(k, v); return f; };
const answer = (text, turnId) => {
  const f = text ? form('audio', sayClip(text), 'a.wav', 'audio/wav') : (() => { const x = new FormData(); x.append('no_speech', '1'); return x; })();
  if (turnId) f.append('turn_id', turnId);
  return f;
};
let turnSeq = 0;

/** One candidate in the browser: what CallPanel does, including its single retry after 1 s on an error. */
async function candidateJourney(api, token, behaviour) {
  const log = { behaviour, outcome: null, error: null, turns: 0, turnWaits: [], startWait: null, queueWait: 0, retriesByClient: 0, over100s: 0 };
  const me = await api.call('me', 'GET', '/api/candidate/me', token);
  if (me.status !== 200) return { ...log, outcome: 'no_access', error: me.body?.message };
  await sleep(15000); // reads the page, picks the PDF
  const resume = await api.call('resume', 'POST', '/api/candidate/resume', token, { form: form('resume', RESUME, 'cv.pdf', 'application/pdf') });
  if (resume.status !== 200) return { ...log, outcome: 'resume_failed', error: resume.body?.message };
  await sleep(10000); // mic check
  await api.call('consent', 'POST', '/api/candidate/consent', token, { json: { agree: true } });

  // Like CallPanel: one id per answer, reused on the retry so the server processes it once.
  const turnOnce = async (text) => {
    const turnId = `t${turnSeq += 1}`;
    let r = await api.call('turn', 'POST', '/api/candidate/call/turn', token, { form: answer(text, turnId) });
    if (r.realMs > 100000) log.over100s += 1; // a Cloudflare tunnel answers 524 after 100 s → browser retries
    if (r.status !== 200) { log.retriesByClient += 1; await sleep(1000); r = await api.call('turn', 'POST', '/api/candidate/call/turn', token, { form: answer(text, turnId) }); }
    log.turnWaits.push(r.realMs);
    return r;
  };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    // Like CallPanel: when every line is busy (429), wait in the queue and try again.
    const queued = Date.now();
    let start = await api.call('start', 'POST', '/api/candidate/call/start', token);
    while (start.status === 429 && start.body?.code === 'lines_busy') {
      await sleep(((start.body.retry_after_seconds || 15) + rand() * 5) * 1000);
      start = await api.call('start', 'POST', '/api/candidate/call/start', token);
    }
    log.queueWait += (Date.now() - queued) * SCALE;
    log.startWait = start.realMs;
    if (start.status !== 200) return { ...log, outcome: 'start_failed', error: start.body?.message };
    await sleep(9000); // intro + first question playing

    const script = behaviour === 'not_ready_first' && attempt === 0 ? ['nahi abhi nahi'] : [...ANSWERS];
    if (behaviour === 'silent_twice' && attempt === 0) script.splice(1, 0, '', '');
    for (let i = 0; i < script.length + 4; i += 1) {
      const text = script[i] ?? 'haan';
      await sleep(6000 + rand() * 6000); // the candidate speaks, then 1.5 s of silence ends the clip
      if (behaviour === 'abandon_tab' && log.turns === 3) return { ...log, outcome: 'abandoned_tab_closed' };
      if (behaviour === 'end_early' && log.turns === 3) {
        await api.call('end', 'POST', '/api/candidate/call/end', token, { json: { reason: 'ended_by_candidate' } });
        return { ...log, outcome: 'ended_early' };
      }
      let r;
      if (behaviour === 'double_submit' && log.turns === 2) {
        const [a, b] = await Promise.all([turnOnce(text), turnOnce(text)]);
        r = a.status === 200 ? a : b;
      } else r = await turnOnce(text);
      log.turns += 1;
      if (r.status !== 200) return { ...log, outcome: 'turn_failed', error: r.body?.message };
      await sleep(4000 * (r.body.lines?.length || 1)); // agent audio playing
      if (r.body.done) {
        if (r.body.outcome === 'not_ready') break;
        return { ...log, outcome: 'completed' };
      }
    }
  }
  return { ...log, outcome: log.outcome || 'did_not_finish' };
}

const pct = (xs, p) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]; };
const sec = (ms) => (ms == null ? null : Math.round(ms / 100) / 10);

async function runScenario(name, arrivalWindowMs) {
  const srv = await startServer();
  const api = client(srv.base);
  const t0 = Date.now();

  // HR: one campaign, 100 candidates, default questions, run. Then try a 101st.
  const batch = (await api.call('hr', 'POST', '/api/hr/batches', ADMIN, { json: { name: `Load ${name}`, job_role: 'Backend Engineer', company_name: 'QA Co' } })).body;
  await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/questions/defaults`, ADMIN);
  const people = Array.from({ length: 100 }, (_, i) => ({ name: `Cand${i + 1} Test`, email: `load${i + 1}@qa.test` }));
  const add = await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/candidates`, ADMIN, { json: { candidates: people } });
  const over = await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/candidates`, ADMIN, { json: { candidates: [{ name: 'Extra', email: 'extra@qa.test' }] } });
  await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/run`, ADMIN);

  const journeys = await Promise.all(people.map(async (p, i) => {
    await sleep((arrivalWindowMs * i) / people.length);
    const r = await candidateJourney(api, `Bearer test:candidate:user-${i + 1}:${p.email}`, pickBehaviour());
    return { email: p.email, ...r, finishedAtRealS: sec((Date.now() - t0) * SCALE) };
  }));
  const callsDoneRealS = sec((Date.now() - t0) * SCALE);

  // Recordings: every finished candidate uploads ~3 MB (a 5-minute Opus WebM) at the same moment.
  srv.child.send('reset-peak');
  const recBefore = (await srv.stats()).memory.rss;
  const finished = journeys.map((j, i) => ({ j, i })).filter(x => ['completed', 'ended_early'].includes(x.j.outcome));
  const rec = await Promise.all(finished.map(({ i }) => api.call('recording', 'POST', '/api/candidate/call/recording', `Bearer test:candidate:user-${i + 1}:load${i + 1}@qa.test`,
    { form: form('recording', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(3 * 1024 * 1024, 1)]), 'call.webm', 'audio/webm') })));
  const recStats = await srv.stats();

  // Results, export and dashboard with 100 rows.
  await sleep(8000);
  const results = await api.call('results', 'GET', `/api/hr/batches/${batch.id}/results`, ADMIN);
  const exportCsv = await api.call('export', 'GET', `/api/hr/batches/${batch.id}/export?format=xlsx`, ADMIN);
  const analytics = await api.call('analytics', 'GET', '/api/hr/analytics', ADMIN);

  const stats = await srv.stats();
  srv.child.send('exit');

  const turnWaits = journeys.flatMap(j => j.turnWaits);
  const outcomes = journeys.reduce((a, j) => ({ ...a, [j.outcome]: (a[j.outcome] || 0) + 1 }), {});
  const byKind = {};
  for (const m of api.metrics) {
    byKind[m.kind] ??= { n: 0, errors: 0, ms: [] };
    byKind[m.kind].n += 1;
    if (m.status >= 400 || m.status === 0) byKind[m.kind].errors += 1;
    byKind[m.kind].ms.push(m.realMs);
  }
  const gaps = stats.db.callGaps.map(g => g.maxGapMs * SCALE);
  return {
    scenario: name,
    scale: SCALE,
    arrival_window_real_s: arrivalWindowMs / 1000,
    hr: { added: add.body?.added, extra_101st_status: over.status },
    outcomes,
    all_calls_finished_after_real_s: callsDoneRealS,
    agent_reply_wait_real_s: { p50: sec(pct(turnWaits, 50)), p90: sec(pct(turnWaits, 90)), p99: sec(pct(turnWaits, 99)), max: sec(Math.max(0, ...turnWaits)) },
    start_wait_real_s: { p50: sec(pct(journeys.map(j => j.startWait).filter(Boolean), 50)), max: sec(Math.max(0, ...journeys.map(j => j.startWait || 0))) },
    waiting_room_real_s: { p50: sec(pct(journeys.map(j => j.queueWait), 50)), p90: sec(pct(journeys.map(j => j.queueWait), 90)), max: sec(Math.max(0, ...journeys.map(j => j.queueWait))) },
    turns_over_10s: turnWaits.filter(w => w > 10000).length,
    turns_over_100s_cloudflare_524: journeys.reduce((a, j) => a + j.over100s, 0),
    client_retries_after_error: journeys.reduce((a, j) => a + j.retriesByClient, 0),
    calls_with_gap_over_3min_would_be_marked_stale: gaps.filter(g => g > 180000).length,
    longest_silence_in_a_call_real_s: sec(Math.max(0, ...gaps)),
    requests: Object.fromEntries(Object.entries(byKind).map(([k, v]) => [k, { n: v.n, errors: v.errors, p50_s: sec(pct(v.ms, 50)), p95_s: sec(pct(v.ms, 95)), max_s: sec(Math.max(...v.ms)) }])),
    usage_that_real_credits_would_pay: { prisma_requests: stats.net.prisma, timbre_requests: stats.net.timbre, llm_requests: stats.net.llm, llm_by_kind: stats.net.llmKinds, max_parallel_gnani: stats.net.maxActive, blocked_outbound_hosts: stats.net.refused },
    db_after: { byStatus: stats.db.byStatus, callsByStatus: stats.db.callsByStatus, calls_with_summary: stats.db.withSummary, stored_files: stats.db.files },
    recordings: { uploads: rec.length, errors: rec.filter(r => r.status !== 200).length, rss_before_mb: Math.round(recBefore / 1e6), peak_rss_mb: Math.round(recStats.memory.peakRss / 1e6) },
    hr_pages_with_100_rows_real_s: { results: sec(results.realMs), export_xlsx: sec(exportCsv.realMs), analytics: sec(analytics.realMs), results_rows: results.body?.rows?.length },
    failures: journeys.filter(j => j.error).map(j => ({ email: j.email, behaviour: j.behaviour, outcome: j.outcome, error: j.error })).slice(0, 15)
  };
}

/** Memory stress: 20 candidates upload the largest allowed recording (19 MB) at the same moment. */
async function memoryStress() {
  const srv = await startServer();
  const api = client(srv.base);
  const batch = (await api.call('hr', 'POST', '/api/hr/batches', ADMIN, { json: { name: 'Mem', job_role: 'QA' } })).body;
  await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/questions/defaults`, ADMIN);
  const people = Array.from({ length: 20 }, (_, i) => ({ name: `M${i}`, email: `mem${i}@qa.test` }));
  await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/candidates`, ADMIN, { json: { candidates: people } });
  await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/run`, ADMIN);
  const tok = (i) => `Bearer test:candidate:mem-${i}:mem${i}@qa.test`;
  for (let i = 0; i < people.length; i += 1) {
    await api.call('resume', 'POST', '/api/candidate/resume', tok(i), { form: form('resume', RESUME, 'cv.pdf', 'application/pdf') });
    await api.call('consent', 'POST', '/api/candidate/consent', tok(i), { json: { agree: true } });
    await api.call('start', 'POST', '/api/candidate/call/start', tok(i));
    await api.call('end', 'POST', '/api/candidate/call/end', tok(i), { json: { reason: 'left_page' } });
  }
  srv.child.send('reset-peak');
  const before = (await srv.stats()).memory.rss;
  // 19 MB: the largest recording the server accepts (20 MB limit since 27 Oct; it was 50 MB). Starts like WebM.
  const big = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(19 * 1024 * 1024 - 4, 7)]);
  const res = await Promise.all(people.map((_, i) => api.call('recording', 'POST', '/api/candidate/call/recording', tok(i), { form: form('recording', big, 'r.webm', 'audio/webm') })));
  const after = await srv.stats();
  srv.child.send('exit');
  return { uploads: res.length, ok: res.filter(r => r.status === 200).length, rss_before_mb: Math.round(before / 1e6), peak_rss_mb: Math.round(after.memory.peakRss / 1e6), added_mb: Math.round((after.memory.peakRss - before) / 1e6) };
}

/**
 * Invite emails: HR runs a 100-person campaign; the app emails everyone through a Gmail-like mailbox
 * (~1.2 s per message, ~3% temporary refusals); HR resends the failed ones; then all 100 open their link
 * within one minute and take the screening to the dashboard.
 */
async function emailScenario() {
  const srv = await startServer({ QA_MAIL: '1' });
  const api = client(srv.base);
  const batch = (await api.call('hr', 'POST', '/api/hr/batches', ADMIN, { json: { name: 'Email load', job_role: 'Backend Engineer', company_name: 'QA Co' } })).body;
  await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/questions/defaults`, ADMIN);
  const people = Array.from({ length: 100 }, (_, i) => ({ name: `Mail${i + 1} Test`, email: `mail${i + 1}@qa.test` }));
  await api.call('hr', 'POST', `/api/hr/batches/${batch.id}/candidates`, ADMIN, { json: { candidates: people } });

  const t0 = Date.now();
  const run = await api.call('run', 'POST', `/api/hr/batches/${batch.id}/run`, ADMIN);
  // Watch the Candidates tab the way HR would, until every row shows Sent or Failed.
  let stats;
  for (;;) {
    await sleep(2000);
    stats = await srv.stats();
    if (stats.mail.rows.every(r => r.sent_at || r.error)) break;
  }
  const allDoneRealS = sec((Date.now() - t0) * SCALE);
  const failedFirst = stats.mail.rows.filter(r => !r.sent_at).map(r => r.id);

  // HR presses "Resend email" on each failed row.
  const resends = [];
  for (const id of failedFirst) resends.push(await api.call('resend', 'POST', `/api/hr/candidates/${id}/send-invite`, ADMIN));
  stats = await srv.stats();

  // Every candidate opens the newest link in their inbox within one minute.
  const inbox = new Map(stats.mail.links.map(l => [l.to, l.link]));
  const joins = await Promise.all(people.map(async (p, i) => {
    await sleep((60000 * i) / people.length);
    const link = inbox.get(p.email);
    if (!link) return { email: p.email, status: 'no_email' };
    const token = decodeURIComponent(new URL(link).searchParams.get('t'));
    const r = await api.call('join', 'POST', '/api/auth/join', '', { json: { token } });
    return { email: p.email, status: r.status, redirectOk: /redirect_to=.*%2Finvite/.test(r.body?.redirect_url || ''), realMs: r.realMs };
  }));
  const after = await srv.stats();
  srv.child.send('exit');

  const wrongLinks = after.mail.links.filter(l => {
    const row = after.mail.rows.find(r => r.email === l.to);
    const id = JSON.parse(Buffer.from(decodeURIComponent(new URL(l.link).searchParams.get('t')).split('.')[0], 'base64url').toString()).c;
    return !row || row.id !== id;
  }).length;
  const joinMs = joins.filter(j => j.realMs).map(j => j.realMs);
  return {
    scenario: 'invite_emails',
    run_response_real_s: sec(run.realMs),
    run_reported: run.body?.emails,
    all_emails_settled_after_real_s: allDoneRealS,
    sent_first_try: 100 - failedFirst.length,
    failed_first_try: failedFirst.length,
    resent_ok: resends.filter(r => r.status === 200).length,
    resent_failed: resends.filter(r => r.status !== 200).length,
    smtp_attempts: after.mail.attempts,
    max_parallel_smtp: after.mail.maxParallel,
    emails_with_wrong_candidate_link: wrongLinks,
    // Only delivered emails are listed; a resend after a refusal is that person's first delivered email.
    duplicate_emails: after.mail.links.length - new Set(after.mail.links.map(l => l.to)).size,
    joined_ok: joins.filter(j => j.status === 200 && j.redirectOk).length,
    join_failures: joins.filter(j => j.status !== 200).map(j => ({ email: j.email, status: j.status })),
    join_real_s: { p50: sec(pct(joinMs, 50)), p95: sec(pct(joinMs, 95)), max: sec(Math.max(...joinMs)) },
    screenings_linked_to_accounts: after.mail.rows.filter(r => r.user_id).length,
    blocked_outbound_hosts: after.net.refused
  };
}

const which = process.env.QA_SCENARIO;
const out = { generated_at: new Date().toISOString(), note: 'All Gnani/LLM traffic was answered by in-process fakes; no credits were used. Times are real-world equivalents (measured × scale).', scenarios: [] };
fs.mkdirSync(REPORT_DIR, { recursive: true });
if (!which || which === 'burst') out.scenarios.push(await runScenario('burst', 60000));
if (!which || which === 'steady') out.scenarios.push(await runScenario('steady', 20 * 60000));
if (!which || which === 'memory') out.memory_stress = await memoryStress();
if (!which || which === 'email') out.invite_emails = await emailScenario();
fs.writeFileSync(path.join(REPORT_DIR, 'load-report.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
