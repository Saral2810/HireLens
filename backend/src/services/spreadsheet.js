/**
 * ─── Candidate spreadsheets ─────────────────────────────────────────────────
 * Reads name + email rows from an uploaded Excel or CSV table. Pure functions; the validation of
 * each row happens later in normalizeCandidateRows (utils/validation.js) when HR adds them.
 */

const NAME_HEADERS = ['name', 'full name', 'candidate', 'candidate name'];
const EMAIL_HEADERS = ['email', 'e-mail', 'email address', 'email id', 'mail'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Text of one ExcelJS cell value (plain, rich text, hyperlink, formula result or date). */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if (Array.isArray(value.richText)) return value.richText.map(r => r.text).join('').trim();
    if (value.text !== undefined) return cellText(value.text);
    if (value.result !== undefined) return cellText(value.result);
    if (value.hyperlink) return String(value.hyperlink).replace(/^mailto:/i, '').trim();
    return '';
  }
  return String(value).trim();
}

/** Minimal CSV reader (quotes, escaped quotes, commas/semicolons, CRLF). */
export function parseCsvTable(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const sep = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) { row.push(cell.trim()); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(cell.trim()); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell.trim()); rows.push(row); }
  return rows.filter(r => r.some(c => c !== ''));
}

/**
 * Finds the name and email columns (by header, or by content when there is no header row)
 * and returns the rows.
 * @param {string[][]} table
 * @returns {{ rows: { name: string, email: string }[], columns: { name: number, email: number }, header: boolean } | { error: string }}
 */
export function rowsFromTable(table) {
  const rows = (table || []).filter(r => r.some(c => String(c || '').trim()));
  if (!rows.length) return { error: 'The file has no rows.' };

  const head = rows[0].map(c => String(c || '').trim().toLowerCase());
  let nameCol = head.findIndex(h => NAME_HEADERS.includes(h));
  let emailCol = head.findIndex(h => EMAIL_HEADERS.includes(h));
  const header = nameCol !== -1 || emailCol !== -1;

  if (emailCol === -1) {
    // No email header: the column whose cells look most like emails.
    const width = Math.max(...rows.map(r => r.length));
    let best = -1;
    let bestCount = 0;
    for (let c = 0; c < width; c += 1) {
      const count = rows.filter(r => EMAIL_RE.test(String(r[c] || '').trim())).length;
      if (count > bestCount) { best = c; bestCount = count; }
    }
    emailCol = best;
  }
  if (emailCol === -1) return { error: 'No email column found. Add a header row with "Name" and "Email".' };
  if (nameCol === -1) nameCol = emailCol === 0 ? 1 : 0;

  const body = header ? rows.slice(1) : rows;
  return {
    header,
    columns: { name: nameCol, email: emailCol },
    rows: body.map(r => ({ name: String(r[nameCol] || '').trim(), email: String(r[emailCol] || '').trim().toLowerCase() }))
      .filter(r => r.name || r.email)
  };
}
