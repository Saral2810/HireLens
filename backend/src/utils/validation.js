// Input validation for the HR API, and parsing helpers for spoken screening answers.

export const ANSWER_TYPES = ['text', 'number', 'yes_no', 'ctc', 'duration'];
export const MAX_CANDIDATES_PER_BATCH = 100;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanText(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/**
 * Validates a batch create/update body.
 * @param {object} body
 * @param {{ partial?: boolean }} [opts] partial = update: only the fields present are checked
 * @returns {{ value: object, errors: string[] }}
 */
export function validateBatchInput(body = {}, { partial = false } = {}) {
  const value = {};
  const errors = [];
  const has = (k) => body[k] !== undefined;

  for (const [key, label, max] of [['name', 'Batch name', 120], ['job_role', 'Job role', 120]]) {
    if (!partial || has(key)) {
      const v = cleanText(body[key]);
      if (!v) errors.push(`${label} is required.`);
      else if (v.length > max) errors.push(`${label} must be at most ${max} characters.`);
      else value[key] = v;
    }
  }
  if (has('batch_date')) {
    if (!isIsoDate(body.batch_date)) errors.push('Batch date must be a valid date (YYYY-MM-DD).');
    else value.batch_date = body.batch_date;
  }
  for (const [key, label, max] of [['company_name', 'Company name', 120], ['job_description', 'Job description', 4000]]) {
    if (has(key)) {
      const v = typeof body[key] === 'string' ? body[key].trim() : '';
      if (v.length > max) errors.push(`${label} must be at most ${max} characters.`);
      else value[key] = v || null;
    }
  }
  if (partial && Object.keys(value).length === 0 && errors.length === 0) errors.push('Nothing to update.');
  return { value, errors };
}

/**
 * Validates an HR question create/update body.
 * @returns {{ value: object, errors: string[] }}
 */
export function validateQuestionInput(body = {}, { partial = false } = {}) {
  const value = {};
  const errors = [];
  if (!partial || body.question_text !== undefined) {
    const text = cleanText(body.question_text);
    if (text.length < 3) errors.push('Question text must be at least 3 characters.');
    else if (text.length > 300) errors.push('Question text must be at most 300 characters.');
    else value.question_text = text;
  }
  if (!partial || body.answer_type !== undefined) {
    const type = body.answer_type ?? 'text';
    if (!ANSWER_TYPES.includes(type)) errors.push(`Answer type must be one of: ${ANSWER_TYPES.join(', ')}.`);
    else value.answer_type = type;
  }
  if (partial && Object.keys(value).length === 0 && errors.length === 0) errors.push('Nothing to update.');
  return { value, errors };
}

/**
 * Checks uploaded candidate rows ({ name, email }). Emails are lower-cased; repeats inside the
 * upload are reported. Rows are numbered from 1 as HR sees them in the sheet.
 * @returns {{ valid: { name: string, email: string }[], errors: { row: number, message: string }[] }}
 */
export function normalizeCandidateRows(rows) {
  const valid = [];
  const errors = [];
  const seen = new Set();
  if (!Array.isArray(rows)) return { valid, errors: [{ row: 0, message: 'candidates must be a list.' }] };

  rows.forEach((row, i) => {
    const n = i + 1;
    const name = cleanText(row?.name);
    const email = cleanText(row?.email).toLowerCase();
    if (!name) return errors.push({ row: n, message: 'Name is missing.' });
    if (name.length > 120) return errors.push({ row: n, message: 'Name is longer than 120 characters.' });
    if (!EMAIL_RE.test(email)) return errors.push({ row: n, message: `"${row?.email ?? ''}" is not a valid email.` });
    if (seen.has(email)) return errors.push({ row: n, message: `${email} appears more than once in this upload.` });
    seen.add(email);
    valid.push({ name, email });
  });
  return { valid, errors };
}

/**
 * Converts a notice period like "30", "2 months", "1 week" or "Immediate" into days.
 * @returns {number|null} days, or null if it can't be read
 */
export function parseNoticePeriodDays(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const str = String(value).trim().toLowerCase();
  if (/immediate|serving|^0$/.test(str)) return 0;
  const num = parseFloat(str);
  if (isNaN(num) || num < 0) return null;
  if (str.includes('month')) return Math.round(num * 30);
  if (str.includes('week')) return Math.round(num * 7);
  return Math.round(num);
}

/**
 * Reads a non-negative number written with Indian digit grouping or units text,
 * e.g. "12,00,000" → 1200000, "4.5 years" → 4.5.
 * @returns {number|null}
 */
export function parseNumber(value) {
  const num = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, ''));
  return Number.isFinite(num) && num >= 0 ? num : null;
}
