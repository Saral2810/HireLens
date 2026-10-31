/**
 * ─── Results ────────────────────────────────────────────────────────────────
 * Turns calls + answers into one row per candidate for the HR results table and the export
 * (Phase H). Pure functions: no database, no network.
 */

/** The call that represents a candidate: the newest completed one, otherwise the newest of any kind. */
export function pickCall(calls) {
  const newest = [...(calls || [])].sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at));
  return newest.find(c => c.status === 'completed') || newest[0] || null;
}

/** An answer as HR reads it: "60 days", "12 LPA", "Yes", "Skipped", "Not asked (fresher)", or the cleaned text. */
export function displayValue(answer) {
  if (!answer) return '';
  if (answer.extracted_value?.not_asked === 'fresher') return 'Not asked (fresher)';
  if (answer.outcome === 'skipped') return answer.answer_text ? `Skipped (heard: ${answer.answer_text})` : 'Skipped';
  const v = answer.extracted_value || {};
  switch (answer.answer_type) {
    case 'duration': if (typeof v.days === 'number') return v.days === 0 ? 'Immediate' : `${v.days} days`; break;
    case 'ctc': if (typeof v.lpa === 'number') return `${v.lpa} LPA`; break;
    case 'yes_no': if (typeof v.yes === 'boolean') return v.yes ? 'Yes' : 'No'; break;
    case 'number': if (typeof v.value === 'number') return String(v.value); break;
    default: break;
  }
  return (typeof v.text === 'string' && v.text) || answer.answer_text || '';
}

// How a CTC question is told apart: the wanted salary ("expected", "kitni chahte hain") or the one paid now.
const EXPECTED_CTC = /expect|chahte|chahti|chahiye|want|desired|demand|अपेक्षित|चाहते|चाहिए/i;
const CURRENT_CTC = /current|abhi|present|drawing|last|pichl|वर्तमान|अभी/i;

/**
 * The headline numbers HR filters on. CTC questions are told apart by their wording
 * (expected vs current, in English or Hinglish); without either, the first is current, the second
 * expected. A lone salary question about what the candidate wants is never shown as current (BUG-44).
 */
export function keyFacts(answers) {
  const answered = (answers || []).filter(a => a.source === 'hr' && a.outcome === 'answered');
  const notice = answered.find(a => a.answer_type === 'duration' && typeof a.extracted_value?.days === 'number');
  const ctc = answered.filter(a => a.answer_type === 'ctc' && typeof a.extracted_value?.lpa === 'number');
  let expected = ctc.find(a => EXPECTED_CTC.test(a.question_text)) || null;
  let current = ctc.find(a => a !== expected && CURRENT_CTC.test(a.question_text)) || null;
  const rest = ctc.filter(a => a !== expected && a !== current);
  if (!current && rest.length) current = rest.shift();
  if (!expected && rest.length) expected = rest.shift();
  return {
    notice_period_days: notice ? notice.extracted_value.days : null,
    current_ctc_lpa: current ? current.extracted_value.lpa : null,
    expected_ctc_lpa: expected ? expected.extracted_value.lpa : null
  };
}

/**
 * @param {{ candidates: object[], calls: object[], answers: object[] }} input
 *   calls of these candidates, answers of these calls
 * @returns one row per candidate, in the candidates' order
 */
export function buildResultRows({ candidates, calls, answers }) {
  const callsByCandidate = new Map();
  for (const call of calls || []) {
    if (!callsByCandidate.has(call.candidate_id)) callsByCandidate.set(call.candidate_id, []);
    callsByCandidate.get(call.candidate_id).push(call);
  }
  const answersByCall = new Map();
  for (const a of answers || []) {
    if (!answersByCall.has(a.call_id)) answersByCall.set(a.call_id, []);
    answersByCall.get(a.call_id).push(a);
  }

  return (candidates || []).map(c => {
    const all = callsByCandidate.get(c.id) || [];
    const call = pickCall(all);
    const callAnswers = call ? (answersByCall.get(call.id) || []).sort((a, b) => a.position - b.position) : [];
    return {
      candidate_id: c.id,
      name: c.name,
      email: c.email,
      status: c.status,
      failure_reason: c.failure_reason || null,
      attempts: all.length,
      call: call && {
        id: call.id,
        status: call.status,
        started_at: call.started_at,
        ended_at: call.ended_at,
        duration_seconds: call.ended_at ? Math.max(0, Math.round((Date.parse(call.ended_at) - Date.parse(call.started_at)) / 1000)) : null,
        summary: call.summary,
        fit_score: call.fit_score,
        has_recording: !!call.recording_path,
        failure_reason: call.failure_reason
      },
      ...keyFacts(callAnswers),
      answers: callAnswers.map(a => ({
        position: a.position, source: a.source, question_text: a.question_text, answer_type: a.answer_type,
        outcome: a.outcome, attempts: a.attempts, answer_text: a.answer_text, extracted_value: a.extracted_value,
        display: displayValue(a)
      }))
    };
  });
}

/**
 * Table for CSV/Excel: fixed columns, then one column per HR question of the batch (matched by
 * wording, so it follows the batch's current questions), then the resume questions and answers.
 * @returns {{ headers: string[], rows: (string|number|null)[][] }}
 */
export function exportTable(rows, hrQuestions) {
  const hr = [...(hrQuestions || [])].sort((a, b) => a.position - b.position).map(q => q.question_text);
  const headers = [
    'Name', 'Email', 'Status', 'Call date', 'Call length (min)', 'Notice period (days)', 'Current CTC (LPA)', 'Expected CTC (LPA)',
    'Fit score', 'Summary', ...hr, 'Project and resume questions and answers', 'Failure reason'
  ];
  const data = rows.map(r => {
    const byText = new Map(r.answers.filter(a => a.source === 'hr').map(a => [a.question_text.trim().toLowerCase(), a.display]));
    const resume = r.answers.filter(a => a.source === 'general' || a.source === 'resume').map((a, i) => `Q${i + 1}: ${a.question_text}\nA: ${a.display || '-'}`).join('\n\n');
    return [
      r.name, r.email, r.status,
      r.call?.started_at ? r.call.started_at.slice(0, 10) : null,
      r.call?.duration_seconds != null ? Math.round(r.call.duration_seconds / 6) / 10 : null,
      r.notice_period_days, r.current_ctc_lpa, r.expected_ctc_lpa,
      r.call?.fit_score ?? null, r.call?.summary || null,
      ...hr.map(text => byText.get(text.trim().toLowerCase()) ?? null),
      resume || null,
      r.failure_reason || r.call?.failure_reason || null
    ];
  });
  return { headers, rows: data };
}

/** RFC 4180 CSV with a UTF-8 BOM so Excel shows Hindi and ₹ correctly. Cells starting with = + - @ are quoted with a leading ' to block formula injection. */
export function toCsv({ headers, rows }) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
