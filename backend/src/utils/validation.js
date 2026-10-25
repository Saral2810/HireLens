// Parsing helpers for spoken screening answers (reused when the brain extracts values in Phase G).

export const SCREENING_STATUSES = ['pending', 'shortlisted', 'maybe', 'rejected', 'not_interested'];

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
