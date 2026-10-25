import { Router } from 'express';
import multer from 'multer';
import db from '../config/db.js';
import { transcribe, speakCached } from '../services/gnaniSpeech.js';
import { decideTurn, summarizeCall } from '../services/brain.js';
import { buildQuestionPlan } from '../services/questionPlan.js';
import {
  currentStep, questionAfter, isStale, isNotReady, line, answerRow, recordingExtension,
  RECORDING_CONTENT_TYPES, END_REASONS, NOT_READY_LINE, MOVE_ON_LINE
} from '../services/callFlow.js';

/**
 * Screening call API (Phase G). Mounted at /api/candidate/call behind requireAuth + requireRole('candidate').
 *
 *   POST /start      → creates the call, returns the intro and first question as audio
 *   POST /turn       → one answer (WAV) in, the next line(s) out; saves answers as it goes
 *   POST /recording  → the whole-call recording (WebM/OGG) after the call ends
 *   POST /end        → ends a call early (End call button, page closed, browser error)
 *
 * The server keeps the call state (which question, which attempt), so the browser cannot skip ahead.
 * A turn is processed fully (Prisma → brain → Timbre) before anything is saved, so a failed request
 * can be retried with the same answer.
 */
const router = Router();
// 60 s of 16 kHz mono 16-bit WAV is ~1.9 MB; a 10-minute Opus recording is ~5 MB.
const answerUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const recordingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

function conflict(res, message) {
  return res.status(409).json({ error: 'Conflict', message });
}

async function loadOwnCandidate(req, res) {
  const candidate = await db.getCandidateForUser(req.user.id);
  if (!candidate) {
    res.status(404).json({ error: 'Not Found', message: 'No screening invitation found for this account.' });
    return null;
  }
  return candidate;
}

/** Speaks each text (cached where possible) → [{ text, audio_base64, audio_type }]. */
async function voiceLines(texts, callId) {
  const voices = await Promise.all(texts.map(text => speakCached(text, { callId })));
  return texts.map((text, i) => ({ text, audio_base64: voices[i].audio.toString('base64'), audio_type: voices[i].contentType }));
}

/** Marks a call failed and the candidate failed (keeps every answer already saved). */
async function failCall(call, candidateId, reason) {
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

/** Writes the summary and fit score in the background once a call is complete. */
function summarizeLater(callId, batch) {
  (async () => {
    const answers = await db.listAnswers(callId);
    const result = await summarizeCall({ batch, answers });
    if (result.summary) await db.updateCall(callId, { summary: result.summary, fit_score: result.fit_score });
  })().catch(err => console.error(`[Call ${callId}] Summary failed:`, err.message));
}

/** POST /api/candidate/call/start → { call_id, total_questions, position, lines, done:false } */
router.post('/start', async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    await expireStaleCall(candidate);

    if (candidate.status === 'in_call') return conflict(res, 'Your call is already open in another tab or window.');
    if (candidate.status !== 'resume_uploaded') {
      return conflict(res, candidate.status === 'invited'
        ? 'Upload your resume before starting the call.'
        : 'Your screening call has already taken place. Please contact the HR team.');
    }
    if (!candidate.consent_at) return res.status(400).json({ error: 'Bad Request', message: 'Agree to the recording first.' });

    // Claim the candidate first, so a second tab cannot start a second call.
    const claimed = await db.updateCandidateIfStatus(candidate.id, 'resume_uploaded', { status: 'in_call', failure_reason: null });
    if (!claimed) return conflict(res, 'Your call is already open in another tab or window.');

    let call = null;
    try {
      const hrQuestions = await db.listQuestions(candidate.batch_id);
      const plan = buildQuestionPlan({ candidate, batch: candidate.batch, hrQuestions });
      call = await db.createCall({ candidateId: candidate.id, questionPlan: plan });
      const first = plan.questions[0];
      const lines = await voiceLines([plan.intro, first.question_text], call.id);
      await db.updateCall(call.id, { transcript: [line('agent', plan.intro), line('agent', first.question_text, first.position)] });
      res.json({ call_id: call.id, total_questions: plan.questions.length, position: first.position, lines, done: false });
    } catch (err) {
      // A service error before the first question is not the candidate's fault: let them try again.
      if (call) await db.updateCall(call.id, { status: 'failed', failure_reason: `Could not start: ${err.message}`, ended_at: new Date().toISOString() }).catch(() => {});
      await db.updateCandidate(candidate.id, { status: 'resume_uploaded' }).catch(() => {});
      throw err;
    }
  } catch (err) { next(err); }
});

/**
 * POST /api/candidate/call/turn (multipart)
 *   audio      WAV clip of the answer (left out, or no_speech=1, when the browser heard nothing)
 * → { position, lines, done, outcome?: 'completed'|'not_ready', heard, timings }
 */
router.post('/turn', answerUpload.single('audio'), async (req, res, next) => {
  try {
    const started = Date.now();
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    const call = await db.getActiveCallForCandidate(candidate.id);
    if (!call) return conflict(res, 'There is no call in progress.');

    const plan = call.question_plan;
    const answers = await db.listAnswers(call.id);
    const transcript = Array.isArray(call.transcript) ? call.transcript : [];
    const step = currentStep(plan, answers, transcript);
    if (!step) return conflict(res, 'Every question has already been answered.');
    const { question, attempt } = step;

    const silent = req.body?.no_speech === '1' || !req.file?.buffer?.length;
    const heard = silent ? { transcript: '', ms: 0 } : await transcribe(req.file.buffer, { format: 'wav', callId: call.id });
    const decision = await decideTurn({ question: question.question_text, answerType: question.answer_type, transcript: heard.transcript, attempt });

    // Work out what happens next, and voice it, before saving anything.
    let say;
    let outcome = null;
    let upcoming = null;
    if (decision.action === 'repeat') {
      say = [decision.say];
    } else if (isNotReady(question, decision)) {
      say = [NOT_READY_LINE];
      outcome = 'not_ready';
    } else {
      upcoming = questionAfter(plan, question.position);
      if (upcoming) say = decision.action === 'skip' ? [MOVE_ON_LINE, upcoming.question_text] : [upcoming.question_text];
      else { say = [plan.closing]; outcome = 'completed'; }
    }
    const ttsStarted = Date.now();
    const lines = await voiceLines(say, call.id);
    const ttsMs = Date.now() - ttsStarted;

    const now = new Date();
    const updated = [...transcript, line('candidate', heard.transcript, question.position, now)];
    say.forEach((text, i) => {
      const isNextQuestion = upcoming && i === say.length - 1;
      updated.push(line('agent', text, isNextQuestion ? upcoming.position : (decision.action === 'repeat' ? question.position : null), now));
    });

    if (decision.action !== 'repeat') {
      const heardForQuestion = updated.filter(e => e.speaker === 'candidate' && e.position === question.position).map(e => e.text);
      await db.upsertAnswer(call.id, answerRow(question, decision, heardForQuestion));
    }

    const ended = now.toISOString();
    if (outcome === 'not_ready') {
      // Not the candidate's last chance: they can start again when ready.
      await db.updateCall(call.id, { transcript: updated, status: 'failed', failure_reason: 'The candidate was not ready to talk.', ended_at: ended });
      await db.updateCandidate(candidate.id, { status: 'resume_uploaded' });
    } else if (outcome === 'completed') {
      await db.updateCall(call.id, { transcript: updated, status: 'completed', ended_at: ended });
      await db.updateCandidate(candidate.id, { status: 'completed', failure_reason: null });
      summarizeLater(call.id, candidate.batch);
    } else {
      await db.updateCall(call.id, { transcript: updated });
    }

    res.json({
      position: upcoming ? upcoming.position : question.position,
      lines,
      done: !!outcome,
      ...(outcome ? { outcome } : {}),
      heard: heard.transcript,
      decision: decision.action,
      timings: { stt_ms: heard.ms, brain_ms: decision.ms, tts_ms: ttsMs, total_ms: Date.now() - started }
    });
  } catch (err) { next(err); }
});

/** POST /api/candidate/call/recording (multipart, field "recording") → { recording_path } */
router.post('/recording', recordingUpload.single('recording'), async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    if (!req.file?.buffer?.length) return res.status(400).json({ error: 'Bad Request', message: 'A recording file is required.' });
    const ext = recordingExtension(req.file.mimetype);
    if (!ext) return res.status(400).json({ error: 'Bad Request', message: 'The recording must be WebM, OGG, WAV or MP3 audio.' });

    const call = await db.getLatestCallForCandidate(candidate.id);
    if (!call || call.status === 'in_progress') return conflict(res, 'The recording can be uploaded only after the call ends.');
    if (call.recording_path) return conflict(res, 'This call already has a recording.');

    const path = `${candidate.batch_id}/${candidate.id}-${call.id}.${ext}`;
    await db.uploadFile('recordings', path, req.file.buffer, RECORDING_CONTENT_TYPES[ext]);
    await db.updateCall(call.id, { recording_path: path });
    res.json({ recording_path: path });
  } catch (err) { next(err); }
});

/** POST /api/candidate/call/end { reason } → ends the call in progress (safe to repeat). */
router.post('/end', async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    const call = await db.getActiveCallForCandidate(candidate.id);
    if (!call) return res.json({ ended: false });
    const reason = END_REASONS[req.body?.reason] || END_REASONS.client_error;
    await failCall(call, candidate.id, reason);
    res.json({ ended: true });
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
