import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import os from 'os';
import db from '../config/db.js';
import { limits } from '../middleware/rateLimit.js';
import { LimitError, checkCallLimit } from '../services/workspaceLimits.js';
import { transcribe, speakCached, SpeechError } from '../services/gnaniSpeech.js';
import { decideTurn, summarizeCall, translateQuestions, writeCompanyBriefing, soundsLikeFresher, saysNoFullTimeJob } from '../services/brain.js';
import { buildQuestionPlan, spokenText } from '../services/questionPlan.js';
import { allowedLanguages, pickLanguage, phrases, sttLanguage, ttsLanguage } from '../services/callLanguage.js';
import {
  currentStep, nextQuestion, notAskedRow, isFresherCall, isStale, isNotReady, line, answerRow, recordingExtension,
  RECORDING_CONTENT_TYPES, END_REASONS, NOT_READY_REASON, START_FAILED_PREFIX, retriesLeft,
  STALE_CALL_MS, MAX_FREE_NOT_READY, NOT_READY_LIMIT_REASON, recordingLooksLike
} from '../services/callFlow.js';

/**
 * Screening call API (Phase G). Mounted at /api/candidate/call behind requireAuth + requireRole('candidate').
 *
 *   POST /start      → creates the call, returns the intro and first question as audio
 *                      body { language?: 'mixed'|'en'|'hi' } (default mixed: English + Hindi; must be one the
 *                      campaign allows, else the campaign's first language is used)
 *   POST /turn       → one answer (WAV) in, the next line(s) out; saves answers as it goes
 *   POST /recording  → the whole-call recording (WebM/OGG) after the call ends
 *   POST /end        → ends a call early (End call button, page closed, browser error)
 *   POST /retry      → after a call that stopped part-way, lets the candidate start again (limited)
 *
 * The server keeps the call state (which question, which attempt), so the browser cannot skip ahead.
 * A turn is processed fully (Prisma → brain → Timbre) before anything is saved, so a failed request
 * can be retried with the same answer (and the same turn_id, so it is not processed twice).
 */
const router = Router();
// 60 s of 16 kHz mono 16-bit WAV is ~1.9 MB. Answers are small and needed in memory for Prisma.
const answerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024, files: 1 } });
// A 10-minute Opus recording is ~5 MB. Recordings go to a temporary file, not RAM, so many uploads at
// once cannot exhaust the server's memory (BUG-10); the file is streamed to storage and then deleted.
const recordingUpload = multer({ storage: multer.diskStorage({ destination: os.tmpdir() }), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// ── Capacity (BUG-21) ─────────────────────────────────────────────────────
// Gnani takes one request at a time per API key, so every call on this server shares one speech lane.
// Past a few calls at once, every answer waits behind everyone else's. New calls therefore wait in a
// queue (the browser retries on 429) and the calls in progress stay quick. One server process only.
export const BUSY_RETRY_SECONDS = 15;
// 15 was measured with the 100-candidate simulation: replies stay under 10 s and the Gnani lane stays
// nearly full (5 lines left it mostly idle and made a rush take 61 minutes instead of 23).
export function maxActiveCalls() {
  const n = Number(process.env.MAX_ACTIVE_CALLS || 15);
  return Number.isInteger(n) && n > 0 ? n : 15;
}
const activeCalls = new Map(); // call id (or a start reservation) → last activity (ms)
// A line held by a call that went quiet (tab closed without /end) is freed after this long.
const slotIdleMs = () => Number(process.env.CALL_SLOT_IDLE_MS) > 0 ? Number(process.env.CALL_SLOT_IDLE_MS) : STALE_CALL_MS;
function activeCallCount(now = Date.now()) {
  for (const [id, at] of activeCalls) if (now - at > slotIdleMs()) activeCalls.delete(id);
  return activeCalls.size;
}
const touchCall = (id) => activeCalls.set(id, Date.now());
const releaseCall = (id) => activeCalls.delete(id);

// ── One turn at a time per candidate (BUG-05) ─────────────────────────────
// A second answer while one is processing is refused; a repeat of the same turn_id (the browser's
// retry after a timeout) waits for, or replays, the first one's reply instead of running it again.
const turnsInFlight = new Map(); // candidate id → { turnId, promise }
const lastTurns = new Map(); // candidate id → { turnId, status, body, at }
const LAST_TURN_KEEP_MS = 2 * 60 * 1000;

/** Tests: forget capacity and turn state between scenarios. */
export function resetCallState() {
  activeCalls.clear();
  turnsInFlight.clear();
  lastTurns.clear();
}

function conflict(res, message) {
  return res.status(409).json({ error: 'Conflict', message });
}

async function loadOwnCandidate(req, res) {
  let candidate = await db.getCandidateForUser(req.user.id);
  // First visit after Google / email-code sign-in: link the rows HR added for this email.
  if (!candidate && await db.claimCandidatesByEmail(req.user.id, req.user.email)) candidate = await db.getCandidateForUser(req.user.id);
  if (!candidate) {
    res.status(404).json({ error: 'Not Found', message: 'No screening found for this email. Check with HR that they added this exact address and ran the campaign.' });
    return null;
  }
  return candidate;
}

/** Speaks each text (cached where possible) in the call's language → [{ text, audio_base64, audio_type }]. */
async function voiceLines(texts, callId, language) {
  const voices = await Promise.all(texts.map(text => speakCached(text, { callId, language: ttsLanguage(language) })));
  return texts.map((text, i) => ({ text, audio_base64: voices[i].audio.toString('base64'), audio_type: voices[i].contentType }));
}

/** Marks a call failed and the candidate failed (keeps every answer already saved). */
async function failCall(call, candidateId, reason) {
  releaseCall(call.id);
  const ended = new Date().toISOString();
  await db.updateCall(call.id, { status: 'failed', failure_reason: reason, ended_at: ended });
  await db.updateCandidate(candidateId, { status: 'failed', failure_reason: reason });
}

/**
 * If the candidate is shown as in a call but that call has gone quiet (tab closed without the
 * /end request getting through), marks it failed. Used by GET /api/candidate/me and /start.
 * @returns {Promise<boolean>} true if the candidate's status changed
 */
export async function expireStaleCall(candidate) {
  if (candidate?.status !== 'in_call') return false;
  const active = await db.getActiveCallForCandidate(candidate.id);
  if (active && !isStale(active)) return false;
  const reason = 'The call stopped without finishing (no answer for 3 minutes).';
  if (active) await failCall(active, candidate.id, reason);
  else await db.updateCandidate(candidate.id, { status: 'failed', failure_reason: reason });
  candidate.status = 'failed';
  return true;
}

// A call asks at most this many follow-up questions (one per question), to stay near seven minutes.
// The two project questions come first, so they get their cross-question before the resume questions.
export const MAX_FOLLOW_UPS = 3;
const FOLLOW_UP_SOURCES = ['general', 'resume'];

/** The campaign facts the company briefing is written from. */
export function briefingInput(batch) {
  return { companyName: batch?.company_name, jobRole: batch?.job_role, companyIntro: batch?.company_intro, jobDescription: batch?.job_description };
}

/**
 * Adds what the call needs in its language: the company briefing (from HR's company intro) and, for
 * an English or Hindi call, spoken_text (the translation) on the resume and HR questions.
 * question_text keeps HR's wording, so answers still line up with the campaign's questions.
 */
async function localizePlan(plan, batch) {
  const asked = plan.questions.filter(q => q.source !== 'intro');
  const [{ lines }, briefing] = await Promise.all([
    translateQuestions(asked.map(q => q.question_text), plan.language),
    writeCompanyBriefing(briefingInput(batch), plan.language)
  ]);
  const spoken = new Map(asked.map((q, i) => [q.position, lines[i]]));
  return {
    ...plan,
    ...(briefing.text ? { briefing: briefing.text } : {}),
    questions: plan.questions.map(q => (spoken.get(q.position) && spoken.get(q.position) !== q.question_text ? { ...q, spoken_text: spoken.get(q.position) } : q))
  };
}

/** Words Prisma should expect in this call's answers: role, company and the plan's own questions. */
function speechContext(batch, question) {
  const words = [batch?.job_role, batch?.company_name, 'CTC', 'LPA', 'notice period', 'lakh']
    .flatMap(w => String(w || '').split(/[,/]/)).map(w => w.trim()).filter(w => w.length >= 2);
  return {
    keyterms: [...new Set(words)].slice(0, 50),
    topic: `HR screening call in India for a ${batch?.job_role || 'job'} role${batch?.company_name ? ` at ${batch.company_name}` : ''}.`,
    previousText: spokenText(question)
  };
}

/** Writes the summary and fit score in the background once a call is complete. */
// The brain sometimes answers slowly or unreadably; one more try a little later usually works.
const SUMMARY_RETRY_MS = 5000;

function summarizeLater(callId, batch) {
  (async () => {
    const answers = await db.listAnswers(callId);
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await summarizeCall({ batch, answers });
      if (result.summary) {
        await db.updateCall(callId, { summary: result.summary, fit_score: result.fit_score, fit_breakdown: result.fit_breakdown });
        return;
      }
      console.warn(`[Call ${callId}] No summary from the brain (attempt ${attempt}).`);
      if (attempt === 1) await new Promise(r => setTimeout(r, SUMMARY_RETRY_MS));
    }
  })().catch(err => console.error(`[Call ${callId}] Summary failed:`, err.message));
}

/** POST /api/candidate/call/start → { call_id, total_questions, position, lines, done:false } */
router.post('/start', limits.callStart, async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    await expireStaleCall(candidate);

    if (candidate.batch?.status !== 'live') return conflict(res, 'This campaign is not taking calls right now. Please contact the HR team.');
    if (candidate.status === 'in_call') return conflict(res, 'Your call is already open in another tab or window.');
    if (candidate.status !== 'resume_uploaded') {
      return conflict(res, candidate.status === 'invited'
        ? 'Upload your resume before starting the call.'
        : 'Your screening call has already taken place. Please contact the HR team.');
    }
    if (!candidate.consent_at) return res.status(400).json({ error: 'Bad Request', message: 'Agree to the recording first.' });
    // A demo workspace has a set number of calls (they spend speech and LLM credits).
    try {
      await checkCallLimit(candidate.batch?.workspace_id);
    } catch (err) {
      if (err instanceof LimitError) return conflict(res, err.message);
      throw err;
    }

    // Wait for a free line. Checked and reserved in one synchronous step, so two starts cannot both take the last one.
    if (activeCallCount() >= maxActiveCalls()) {
      res.set('Retry-After', String(BUSY_RETRY_SECONDS));
      return res.status(429).json({
        error: 'Busy', code: 'lines_busy', retry_after_seconds: BUSY_RETRY_SECONDS,
        message: 'All interview lines are busy right now. Please stay on this page; your call starts automatically in a moment.'
      });
    }
    const reservation = `start:${candidate.id}`;
    touchCall(reservation);

    // Claim the candidate first, so a second tab cannot start a second call.
    let claimed;
    try {
      claimed = await db.updateCandidateIfStatus(candidate.id, 'resume_uploaded', { status: 'in_call', failure_reason: null });
    } finally {
      if (!claimed) releaseCall(reservation);
    }
    if (!claimed) return conflict(res, 'Your call is already open in another tab or window.');

    let call = null;
    try {
      const hrQuestions = await db.listQuestions(candidate.batch_id);
      const language = pickLanguage(req.body?.language, allowedLanguages(candidate.batch?.call_languages));
      const plan = await localizePlan(buildQuestionPlan({ candidate, batch: candidate.batch, hrQuestions, language }), candidate.batch);
      call = await db.createCall({ candidateId: candidate.id, questionPlan: plan });
      releaseCall(reservation);
      touchCall(call.id);
      const first = plan.questions[0];
      const lines = await voiceLines([plan.intro, spokenText(first)], call.id, language);
      await db.updateCall(call.id, { transcript: [line('agent', plan.intro), line('agent', spokenText(first), first.position)] });
      res.json({ call_id: call.id, total_questions: plan.questions.length, position: first.position, lines, done: false });
    } catch (err) {
      // A service error before the first question is not the candidate's fault: let them try again.
      releaseCall(reservation);
      if (call) releaseCall(call.id);
      if (call) await db.updateCall(call.id, { status: 'failed', failure_reason: `${START_FAILED_PREFIX} ${err.message}`, ended_at: new Date().toISOString() }).catch(() => {});
      await db.updateCandidate(candidate.id, { status: 'resume_uploaded' }).catch(() => {});
      throw err;
    }
  } catch (err) { next(err); }
});

/**
 * POST /api/candidate/call/turn (multipart)
 *   audio      WAV clip of the answer (left out, or no_speech=1, when the browser heard nothing)
 *   turn_id    optional id of this answer; the browser sends the same id when it retries
 * → { position, lines, done, outcome?: 'completed'|'not_ready'|'not_ready_limit', heard, timings }
 */
router.post('/turn', limits.callTurn, answerUpload.single('audio'), async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    const call = await db.getActiveCallForCandidate(candidate.id);
    const turnId = typeof req.body?.turn_id === 'string' && req.body.turn_id.length <= 64 ? req.body.turn_id : null;
    const key = candidate.id;

    // A retry of a turn that already finished (its reply was lost on the way): send the same reply again.
    const last = lastTurns.get(key);
    if (turnId && last?.turnId === turnId) return res.status(last.status).json(last.body);
    // From here to turnsInFlight.set there is no await, so two requests cannot both pass this check.
    const running = turnsInFlight.get(key);
    if (running) {
      if (turnId && running.turnId === turnId) {
        const same = await running.promise;
        return res.status(same.status).json(same.body);
      }
      return conflict(res, 'Your previous answer is still being processed. Please wait a moment.');
    }
    if (!call) return conflict(res, 'There is no call in progress.');

    const promise = processTurn(req, candidate, call);
    turnsInFlight.set(key, { turnId, promise });
    try {
      const result = await promise;
      const now = Date.now();
      for (const [k, v] of lastTurns) if (now - v.at > LAST_TURN_KEEP_MS) lastTurns.delete(k);
      if (turnId) lastTurns.set(key, { turnId, ...result, at: now });
      res.status(result.status).json(result.body);
    } finally {
      turnsInFlight.delete(key);
    }
  } catch (err) { next(err); }
});

/** One answer, start to finish. @returns {Promise<{ status: number, body: object }>} */
async function processTurn(req, candidate, call) {
  const started = Date.now();
  touchCall(call.id);
  const plan = call.question_plan;
  const answers = await db.listAnswers(call.id);
  const transcript = Array.isArray(call.transcript) ? call.transcript : [];
  const step = currentStep(plan, answers, transcript);
  if (!step) return { status: 409, body: { error: 'Conflict', message: 'Every question has already been answered.' } };
  const { question, attempt } = step;
  const language = pickLanguage(plan.language);
  const script = phrases(language);

  const silent = req.body?.no_speech === '1' || !req.file?.buffer?.length;
  let heard = { transcript: '', ms: 0, failed: false };
  if (!silent) {
    try {
      heard = { ...(await transcribe(req.file.buffer, { format: 'wav', language: sttLanguage(language), callId: call.id, ...speechContext(candidate.batch, question) })), failed: false };
    } catch (err) {
      // Speech-to-text still failing after its retries must not end the call: treat the answer as
      // unheard, so the question is asked again (and skipped after a second miss). Setup errors still fail.
      if (!(err instanceof SpeechError) || !err.retryable) throw err;
      console.warn(`[Call ${call.id}] Speech-to-text failed, asking again: ${err.message}`);
      heard = { transcript: '', ms: 0, failed: true };
    }
  }
  // After a follow-up question, the second answer completes the first: no second follow-up, no repeat.
  const followUpAsked = transcript.some(e => e.speaker === 'agent' && e.position === question.position && e.follow_up);
  const followUpsUsed = transcript.filter(e => e.speaker === 'agent' && e.follow_up).length;
  let decision = followUpAsked
    ? { action: 'next', extracted: null, say: null, fresher: soundsLikeFresher(heard.transcript), joinAnswers: true, ms: 0, source: 'rule' }
    : await decideTurn({
      question: spokenText(question), answerType: question.answer_type, transcript: heard.transcript, attempt, language,
      allowFollowUp: FOLLOW_UP_SOURCES.includes(question.source) && !question.experience_check && question.answer_type === 'text'
        && attempt === 1 && followUpsUsed < MAX_FOLLOW_UPS,
      probe: !!question.probe
    });
  // Fresher rule (BUG-43): once the candidate says they are a fresher (anywhere, or "no" to the
  // experience question), notice period and current CTC are not asked.
  const saidFresher = decision.fresher
    || (question.experience_check && !silent && decision.action !== 'repeat' && saysNoFullTimeJob(heard.transcript))
    || (question.experience_check && decision.extracted?.yes === false);
  const fresher = saidFresher || isFresherCall(transcript);
  // "Fresher hoon, notice period nahi hai" in answer to the notice or current-CTC question itself:
  // that question is done (not applicable), it is never repeated.
  if (fresher && question.fresher_skip && !question.experience_check && decision.action !== 'next') {
    decision = { ...decision, action: 'next', say: null, notApplicable: true };
  } else if (fresher && question.fresher_skip && !question.experience_check) {
    decision = { ...decision, notApplicable: true };
  }

  // Work out what happens next, and voice it, before saving anything.
  let say;
  let outcome = null;
  let upcoming = null;
  let notAsked = [];
  if (decision.action === 'repeat' || decision.action === 'follow_up') {
    say = [decision.say];
  } else if (isNotReady(question, decision)) {
    // Free "not ready" ends are limited (BUG-07); past the limit this call ends as failed.
    const earlier = (await db.listCallsForCandidates([candidate.id])).filter(k => k.id !== call.id && k.failure_reason === NOT_READY_REASON).length;
    outcome = earlier >= MAX_FREE_NOT_READY ? 'not_ready_limit' : 'not_ready';
    say = [outcome === 'not_ready' ? script.notReady : script.notReadyLimit];
  } else {
    ({ question: upcoming, notAsked } = nextQuestion(plan, question.position, { fresher }));
    // The company briefing comes once, right after the candidate says they are ready.
    const briefing = question.source === 'intro' && plan.briefing ? [plan.briefing] : [];
    if (upcoming) say = [...(decision.action === 'skip' ? [script.moveOn] : []), ...briefing, spokenText(upcoming)];
    else { say = [plan.closing]; outcome = 'completed'; }
  }
  const ttsStarted = Date.now();
  const lines = await voiceLines(say, call.id, language);
  const ttsMs = Date.now() - ttsStarted;

  const now = new Date();
  const updated = [...transcript, {
    ...line('candidate', heard.transcript, question.position, now),
    ...(heard.failed ? { note: 'speech_service_error' } : {}),
    ...(saidFresher ? { fresher: true } : {})
  }];
  say.forEach((text, i) => {
    const isNextQuestion = upcoming && i === say.length - 1;
    const sameQuestion = decision.action === 'repeat' || decision.action === 'follow_up';
    updated.push({
      ...line('agent', text, isNextQuestion ? upcoming.position : (sameQuestion ? question.position : null), now),
      ...(decision.action === 'follow_up' ? { follow_up: true } : {})
    });
  });

  if (decision.action !== 'repeat' && decision.action !== 'follow_up') {
    const heardForQuestion = updated.filter(e => e.speaker === 'candidate' && e.position === question.position).map(e => e.text);
    await db.upsertAnswer(call.id, decision.notApplicable
      ? { ...notAskedRow(question), answer_text: heardForQuestion.filter(Boolean).join(' / ') || null, attempts: Math.max(1, heardForQuestion.length) }
      : answerRow(question, decision, heardForQuestion));
    for (const q of notAsked) await db.upsertAnswer(call.id, notAskedRow(q));
  }

  const ended = now.toISOString();
  if (outcome) releaseCall(call.id);
  if (outcome === 'not_ready') {
    // Not the candidate's last chance: they can start again when ready.
    await db.updateCall(call.id, { transcript: updated, status: 'failed', failure_reason: NOT_READY_REASON, ended_at: ended });
    await db.updateCandidate(candidate.id, { status: 'resume_uploaded' });
  } else if (outcome === 'not_ready_limit') {
    await db.updateCall(call.id, { transcript: updated, status: 'failed', failure_reason: NOT_READY_LIMIT_REASON, ended_at: ended });
    await db.updateCandidate(candidate.id, { status: 'failed', failure_reason: NOT_READY_LIMIT_REASON });
  } else if (outcome === 'completed') {
    await db.updateCall(call.id, { transcript: updated, status: 'completed', ended_at: ended });
    await db.updateCandidate(candidate.id, { status: 'completed', failure_reason: null });
    summarizeLater(call.id, candidate.batch);
  } else {
    await db.updateCall(call.id, { transcript: updated });
  }

  return { status: 200, body: {
    position: upcoming ? upcoming.position : question.position,
    lines,
    done: !!outcome,
    ...(outcome ? { outcome } : {}),
    heard: heard.transcript,
    ...(heard.failed ? { speech_error: true } : {}),
    decision: decision.action,
    timings: { stt_ms: heard.ms, brain_ms: decision.ms, tts_ms: ttsMs, total_ms: Date.now() - started }
  } };
}

/** POST /api/candidate/call/recording (multipart, field "recording") → { recording_path } */
router.post('/recording', limits.recording, recordingUpload.single('recording'), async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    if (!req.file?.size) return res.status(400).json({ error: 'Bad Request', message: 'A recording file is required.' });
    const ext = recordingExtension(req.file.mimetype);
    // The browser's label is not trusted: the file must also start like that kind of audio (BUG-08).
    const head = Buffer.alloc(12);
    const fd = await fs.promises.open(req.file.path, 'r');
    try { await fd.read(head, 0, 12, 0); } finally { await fd.close(); }
    if (!ext || !recordingLooksLike(ext, head)) return res.status(400).json({ error: 'Bad Request', message: 'The recording must be WebM, OGG, WAV or MP3 audio.' });

    const call = await db.getLatestCallForCandidate(candidate.id);
    if (!call || call.status === 'in_progress') return conflict(res, 'The recording can be uploaded only after the call ends.');
    if (call.recording_path) return conflict(res, 'This call already has a recording.');

    const path = `${candidate.batch_id}/${candidate.id}-${call.id}.${ext}`;
    // A file-backed Blob is streamed to storage from disk, never loaded whole into memory.
    await db.uploadFile('recordings', path, await fs.openAsBlob(req.file.path, { type: RECORDING_CONTENT_TYPES[ext] }), RECORDING_CONTENT_TYPES[ext]);
    await db.updateCall(call.id, { recording_path: path });
    res.json({ recording_path: path });
  } catch (err) {
    next(err);
  } finally {
    if (req.file?.path) fs.promises.unlink(req.file.path).catch(() => {});
  }
});

/** POST /api/candidate/call/end { reason } → ends the call in progress (safe to repeat). */
router.post('/end', async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    const call = await db.getActiveCallForCandidate(candidate.id);
    if (!call) return res.json({ ended: false });
    // Own keys only: "constructor" or "toString" must not count as a reason (BUG-06).
    const reason = Object.hasOwn(END_REASONS, String(req.body?.reason)) ? END_REASONS[req.body.reason] : END_REASONS.client_error;
    await failCall(call, candidate.id, reason);
    res.json({ ended: true });
  } catch (err) { next(err); }
});

/**
 * POST /api/candidate/call/retry → { status, retries_left }
 * After a call that stopped part-way (error, page closed, ended early), the candidate may start
 * again from the beginning, up to MAX_CALL_ATTEMPTS calls in total. Earlier calls stay saved.
 */
router.post('/retry', async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    await expireStaleCall(candidate);
    if (candidate.status !== 'failed') {
      return conflict(res, candidate.status === 'completed' ? 'Your call is already complete.' : 'There is no stopped call to retry.');
    }
    const left = retriesLeft(await db.listCallsForCandidates([candidate.id]));
    if (left <= 0) return conflict(res, 'You have used all your attempts. Please contact the HR team for another try.');

    const updated = await db.updateCandidateIfStatus(candidate.id, 'failed', {
      status: candidate.resume_path ? 'resume_uploaded' : 'invited', failure_reason: null
    });
    if (!updated) return conflict(res, 'Your status changed. Reload the page.');
    res.json({ status: updated.status, retries_left: left - 1 });
  } catch (err) { next(err); }
});

router.use((err, req, res, next) => {
  if (err?.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'The audio file is too large.' : 'Upload one audio file.';
    return res.status(400).json({ error: 'Bad Request', message });
  }
  next(err);
});

export default router;
