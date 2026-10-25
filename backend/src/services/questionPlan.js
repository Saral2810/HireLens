/**
 * ─── Question plan ──────────────────────────────────────────────────────────
 * The fixed script of one screening call: intro → resume questions → HR questions → closing.
 * Saved to calls.question_plan when the call starts, so every call can be replayed exactly.
 */

/** First name for a friendly greeting ("Asha Rao" → "Asha"). */
function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

/**
 * @param {{
 *   candidate: { name: string, resume_questions?: { question_text: string, answer_type?: string }[] },
 *   batch: { job_role: string, company_name?: string|null },
 *   hrQuestions: { question_text: string, answer_type: string, position: number }[]
 * }} input
 * @returns {{ intro: string, questions: { position: number, source: 'intro'|'resume'|'hr', question_text: string, answer_type: string }[], closing: string }}
 */
export function buildQuestionPlan({ candidate, batch, hrQuestions = [] }) {
  const name = firstName(candidate.name);
  const company = batch.company_name ? ` ${batch.company_name} ki taraf se` : '';
  const intro = `Namaste${name ? ` ${name}` : ''}! Main${company} AI screening assistant bol rahi hoon, ${batch.job_role} role ke liye.`
    + ' Yeh call record ho rahi hai aur lagbhag paanch minute ki hogi.';

  const questions = [
    { source: 'intro', question_text: 'Kya aap abhi baat karne ke liye ready hain?', answer_type: 'yes_no' },
    ...(candidate.resume_questions || []).map(q => ({ source: 'resume', question_text: q.question_text, answer_type: q.answer_type || 'text' })),
    ...[...hrQuestions].sort((a, b) => a.position - b.position).map(q => ({ source: 'hr', question_text: q.question_text, answer_type: q.answer_type }))
  ].map((q, position) => ({ position, ...q }));

  const closing = `Dhanyavaad${name ? ` ${name}` : ''}! Aapke saare answers record ho gaye hain. HR team jaldi aapse contact karegi. Aapka din shubh ho.`;
  return { intro, questions, closing };
}
