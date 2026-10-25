// Minimal CSV reading for the "add candidates" upload: quoted fields, commas or semicolons,
// Windows or Unix line endings. Only name and email columns are used.

/** Splits CSV text into rows of cells (RFC 4180 quoting). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const delimiter = detectDelimiter(text);
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some(c => c.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some(c => c.trim() !== '')) rows.push(row);
  return rows;
}

function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const count = (c: string) => firstLine.split(c).length - 1;
  if (count('\t') > count(',') && count('\t') > count(';')) return '\t';
  return count(';') > count(',') ? ';' : ',';
}

const NAME_HEADERS = ['name', 'full name', 'fullname', 'candidate name', 'candidate', 'applicant name'];
const EMAIL_HEADERS = ['email', 'e-mail', 'email id', 'email address', 'mail', 'emailid'];
const normalizeHeader = (h: string) => h.trim().toLowerCase().replace(/[_]+/g, ' ').replace(/\s+/g, ' ');

export interface CandidateCsvResult {
  rows: { name: string; email: string }[];
  /** Set when the name or email column could not be found. */
  problem: string | null;
}

/**
 * Reads candidates from CSV text. The first row must be headers containing a name and an email
 * column (e.g. "Name", "Full Name", "Email ID"). With no header row, "name, email" order is assumed.
 */
export function readCandidatesCsv(text: string): CandidateCsvResult {
  const table = parseCsv(text.replace(/^﻿/, ''));
  if (!table.length) return { rows: [], problem: 'The file is empty.' };

  const headers = table[0].map(normalizeHeader);
  let nameCol = headers.findIndex(h => NAME_HEADERS.includes(h));
  let emailCol = headers.findIndex(h => EMAIL_HEADERS.includes(h));
  let body = table.slice(1);

  if (nameCol === -1 && emailCol === -1 && table[0].length >= 2 && table[0][1].includes('@')) {
    // No header row: assume "name, email".
    nameCol = 0;
    emailCol = 1;
    body = table;
  }
  if (nameCol === -1 || emailCol === -1) {
    return { rows: [], problem: 'Could not find "Name" and "Email" columns in the first row.' };
  }
  return {
    rows: body.map(cells => ({ name: (cells[nameCol] || '').trim(), email: (cells[emailCol] || '').trim() })),
    problem: null
  };
}
