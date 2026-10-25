/**
 * ─── Call flow ──────────────────────────────────────────────────────────────
 * Pure helpers for the screening call state (no database, no network), used by routes/call.js.
 * The state lives in the database: calls.question_plan (the script), answers (one row per
 * finished question) and calls.transcript (every line spoken, with its plan position).
 */

// No saved turn for this long means the candidate left (closed the tab, lost the network, laptop slept).
// The longest normal gap is one 60 s answer plus playback and processing.
export const STALE_CALL_MS = 3 * 60 * 1000;

export const NOT_READY_LINE = 'Koi baat nahi! Jab aap ready hon, tab is page par wapas aakar Start call dabaiye. Dhanyavaad.';
export const MOVE_ON_LINE = 'Koi baat nahi, aage badhte hain.';

// Why a call ended early; the client may only send these.
export const END_REASONS = {
  ended_by_candidate: 'The candidate ended the call.',
  left_page: 'The candidate left the call page.',
  client_error: 'The call stopped because of a technical problem (connection or speech service).'
};

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
 * @param {{ action: string, extracted: object|null }} decision
 * @param {string[]} heard every transcript the candidate gave for this question, oldest first
 */
export function answerRow(question, decision, heard) {
  const said = heard.map(t => (t || '').trim()).filter(Boolean);
  const skipped = decision.action === 'skip';
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
