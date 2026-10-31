import { callLanguage, phrases } from './callLanguage.js';

/**
 * ─── Question plan ──────────────────────────────────────────────────────────
 * The script of one screening call, in this order:
 *   1. intro: greeting and "ready?" (then the company briefing is spoken)
 *   2. general: the project they are most proud of, then the biggest problem in it and how they solved
 *      it (the agent cross-questions both answers)
 *   3. resume: questions written from their own resume
 *   4. general: "full-time experience or fresher?" (only when HR asks notice period / current CTC)
 *   5. hr: HR's own questions; a fresher is not asked notice period or current CTC
 *   then the closing line.
 * Saved to calls.question_plan when the call starts, so every call can be replayed exactly.
 */

// Resume questions asked in a call (the resume step writes 3 to 5; the call keeps time near seven minutes).
export const RESUME_QUESTIONS_IN_CALL = 3;

/** First name for a friendly greeting ("Asha Rao" → "Asha"). */
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// Wording of questions only someone with a job can answer, in English, Hinglish or Hindi.
const NOTICE_WORDS = /notice|serving|resign|relieving|नोटिस/i;
const CURRENT_PAY_WORDS = /(current|present|abhi|last|pichl|drawing|existing|वर्तमान|अभी)\W*(\w+\W+){0,3}(ctc|salary|package|pay|सैलरी|वेतन)|(ctc|salary|package)\W*(\w+\W+){0,3}(current|abhi|present|drawn|अभी)|current (company|employer|job)|abhi (kahan|kis company)/i;
const EXPECTED_WORDS = /expect|chahte|chahti|chahiye|want|desired|अपेक्षित|चाहते|चाहिए/i;

/**
 * HR questions that make no sense for a fresher: the notice period and the CURRENT salary or job,
 * whatever answer type HR picked. A question about expected salary is still asked.
 */
export function skipForFresher(question) {
  const text = String(question?.question_text || '');
  if (EXPECTED_WORDS.test(text)) return false;
  if (question?.answer_type === 'duration' && NOTICE_WORDS.test(text)) return true;
  if (question?.answer_type === 'ctc') return true;
  return NOTICE_WORDS.test(text) || CURRENT_PAY_WORDS.test(text);
}

/** What the agent says for a plan question (a translation when the call is not in Hinglish). */
export function spokenText(question) {
  return question?.spoken_text || question?.question_text || '';
}

/**
 * @param {{
 *   candidate: { name: string, is_fresher?: boolean, resume_questions?: { question_text: string, answer_type?: string }[] },
 *   batch: { job_role: string, company_name?: string|null },
 *   hrQuestions: { question_text: string, answer_type: string, position: number }[],
 *   language?: 'mixed'|'en'|'hi'
 * }} input
 * @returns {{ language: string, intro: string, questions: { position: number, source: 'intro'|'general'|'resume'|'hr', question_text: string, answer_type: string,
 *   fresher_skip?: true, probe?: true, experience_check?: true }[], closing: string }}
 *   A candidate already known to be a fresher is not given the fresher_skip questions at all.
 */
export function buildQuestionPlan({ candidate, batch, hrQuestions = [], language }) {
  const lang = callLanguage(language);
  const say = phrases(lang);
  const name = firstName(candidate.name);
  const intro = say.intro({ name, company: batch.company_name || '', role: batch.job_role });

  const hr = [...hrQuestions]
    .sort((a, b) => a.position - b.position)
    .map(q => ({ source: 'hr', question_text: q.question_text, answer_type: q.answer_type, ...(skipForFresher(q) ? { fresher_skip: true } : {}) }));
  // Asked only when HR has questions a fresher skips, and the resume did not already show a fresher.
  // It counts as a fresher question itself: once the candidate has said they are a fresher it is not asked.
  const experienceCheck = hr.some(q => q.fresher_skip)
    ? [{ source: 'general', question_text: say.experienceCheck, answer_type: 'text', experience_check: true, fresher_skip: true }]
    : [];

  const questions = [
    { source: 'intro', question_text: say.ready, answer_type: 'yes_no' },
    // probe: the agent cross-questions these answers (how, why that way, what result).
    { source: 'general', question_text: say.proudProject, answer_type: 'text', probe: true },
    { source: 'general', question_text: say.problems, answer_type: 'text', probe: true },
    ...(candidate.resume_questions || []).slice(0, RESUME_QUESTIONS_IN_CALL)
      .map(q => ({ source: 'resume', question_text: q.question_text, answer_type: q.answer_type || 'text' })),
    ...experienceCheck,
    ...hr
  ]
    .filter(q => !(candidate.is_fresher && q.fresher_skip))
    .map((q, position) => ({ position, ...q }));

  const closing = say.closing({ name });
  return { language: lang, intro, questions, closing };
}
