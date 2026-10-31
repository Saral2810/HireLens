import { PHRASES } from './callLanguage.js';

/**
 * ─── Call flow ──────────────────────────────────────────────────────────────
 * Pure helpers for the screening call state (no database, no network), used by routes/call.js.
 * The state lives in the database: calls.question_plan (the script), answers (one row per
 * finished question) and calls.transcript (every line spoken, with its plan position).
 */

// No saved turn for this long means the candidate left (closed the tab, lost the network, laptop slept).
// The longest normal gap is one 60 s answer plus playback and processing.
export const STALE_CALL_MS = 3 * 60 * 1000;

// The Hinglish lines; callLanguage.js has them in every call language.
export const NOT_READY_LINE = PHRASES.mixed.notReady;
export const MOVE_ON_LINE = PHRASES.mixed.moveOn;
export const NOT_READY_REASON = 'The candidate was not ready to talk.';
export const START_FAILED_PREFIX = 'Could not start:';

// "Not ready" ends a call without using an attempt, but only this many times; the next "not ready"
// fails the call (it then counts as an attempt), so nobody can restart for free forever (BUG-07).
export const MAX_FREE_NOT_READY = 2;
export const NOT_READY_LIMIT_LINE = PHRASES.mixed.notReadyLimit;
export const NOT_READY_LIMIT_REASON = 'The candidate said they were not ready three times. HR can allow a retake.';

// A candidate may take the call this many times on their own; HR can allow more with Retake.
// Calls ended with "not ready" or that failed before the first question do not count.
export const MAX_CALL_ATTEMPTS = 3;

/** How many more times the candidate may start the call themselves (0 once a call is completed). */
export function retriesLeft(calls = []) {
  if (calls.some(c => c.status === 'completed')) return 0;
  const used = calls.filter(c => c.failure_reason !== NOT_READY_REASON && !String(c.failure_reason || '').startsWith(START_FAILED_PREFIX)).length;
  return Math.max(0, MAX_CALL_ATTEMPTS - used);
}

// Why a call ended early; the client may only send these. No prototype, so names like "constructor"
// sent by a client are not mistaken for reasons (BUG-06).
export const END_REASONS = Object.freeze(Object.assign(Object.create(null), {
  ended_by_candidate: 'The candidate ended the call.',
  left_page: 'The candidate left the call page.',
  client_error: 'The call stopped because of a technical problem (connection or speech service).'
}));

/**
 * The question to ask now: the first one in the plan without a saved answer.
 * @returns {{ question: { position: number, source: string, question_text: string, answer_type: string }, attempt: number }|null}
 *   attempt = 1 the first time, 2 after one unclear answer. null = every question is answered.
 */
export function currentStep(plan, answers = [], transcript = []) {
  const done = new Set(answers.map(a => a.position));
  const question = (plan?.questions || []).find(q => !done.has(q.position));
  if (!question) return null;
  const heard = transcript.filter(e => e.speaker === 'candidate' && e.position === question.position).length;
  return { question, attempt: heard + 1 };
}

/** The question after `position`, or null at the end of the plan. */
export function questionAfter(plan, position) {
  return (plan?.questions || []).find(q => q.position > position) || null;
}

/** True once the candidate has said in this call that they are a fresher (marked on their transcript line). */
export function isFresherCall(transcript = []) {
  return transcript.some(e => e?.speaker === 'candidate' && e.fresher === true);
}

/**
 * The next question to ask after `position`. For a fresher, the notice period and current CTC
 * questions (fresher_skip) are passed over and returned in `notAsked`, to be saved as not asked.
 * @returns {{ question: object|null, notAsked: object[] }} question null = end of the plan
 */
export function nextQuestion(plan, position, { fresher = false } = {}) {
  const notAsked = [];
  for (const q of plan?.questions || []) {
    if (q.position <= position) continue;
    if (fresher && q.fresher_skip) { notAsked.push(q); continue; }
    return { question: q, notAsked };
  }
  return { question: null, notAsked };
}

/** The answers row for a question left out because the candidate is a fresher. */
export function notAskedRow(question) {
  return {
    position: question.position,
    question_text: question.question_text,
    source: question.source,
    answer_type: question.answer_type,
    answer_text: null,
    extracted_value: { not_asked: 'fresher' },
    outcome: 'skipped',
    attempts: 1
  };
}

/** Latest moment something was saved for this call. */
export function lastActivityMs(call) {
  const times = [Date.parse(call.started_at)];
  for (const e of call.transcript || []) if (e?.at) times.push(Date.parse(e.at));
  return Math.max(...times.filter(Number.isFinite));
}

export function isStale(call, now = Date.now()) {
  return call?.status === 'in_progress' && now - lastActivityMs(call) > STALE_CALL_MS;
}

/** The opening yes/no question answered with "no". */
export function isNotReady(question, decision) {
  return question.source === 'intro' && decision.action === 'next' && decision.extracted?.yes === false;
}

/** A transcript line. position = plan position it belongs to (null for intro and closing). */
export function line(speaker, text, position = null, at = new Date()) {
  return { speaker, text, position, at: at.toISOString() };
}

/**
 * The answers row for a question that is finished (accepted or skipped).
 * @param {object} question plan question
 * @param {{ action: string, extracted: object|null, joinAnswers?: boolean }} decision
 *   joinAnswers = the answer came in two parts (a follow-up question was asked): both are kept
 * @param {string[]} heard every transcript the candidate gave for this question, oldest first
 */
export function answerRow(question, decision, heard) {
  const said = heard.map(t => (t || '').trim()).filter(Boolean);
  const skipped = decision.action === 'skip';
  const joined = said.join(' / ') || null;
  if (decision.joinAnswers && !skipped) {
    return {
      position: question.position, question_text: question.question_text, source: question.source, answer_type: question.answer_type,
      answer_text: joined, extracted_value: joined ? { text: joined } : null, outcome: joined ? 'answered' : 'skipped', attempts: Math.max(1, heard.length)
    };
  }
  return {
    position: question.position,
    question_text: question.question_text,
    source: question.source,
    answer_type: question.answer_type,
    answer_text: (skipped ? said.join(' / ') : said[said.length - 1]) || null,
    extracted_value: skipped ? null : decision.extracted || null,
    outcome: skipped ? 'skipped' : 'answered',
    attempts: Math.max(1, heard.length)
  };
}

/** Storage file extension for a browser recording, or null if the type is not accepted. */
export function recordingExtension(mimeType) {
  const type = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return { 'audio/webm': 'webm', 'video/webm': 'webm', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' }[type] || null;
}

export const RECORDING_CONTENT_TYPES = { webm: 'audio/webm', ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg' };

/** True when the file's first bytes match its claimed audio type (WebM/EBML, Ogg, RIFF WAV, MP3). */
export function recordingLooksLike(ext, head) {
  const b = Buffer.from(head || []);
  switch (ext) {
    case 'webm': return b.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    case 'ogg': return b.subarray(0, 4).toString('latin1') === 'OggS';
    case 'wav': return b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WAVE';
    case 'mp3': return b.subarray(0, 3).toString('latin1') === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0);
    default: return false;
  }
}
