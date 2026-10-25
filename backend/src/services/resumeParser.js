import { extractText, getDocumentProxy } from 'unpdf';

/**
 * ─── Resume text ─────────────────────────────────────────────────────────────
 * Pulls plain text out of a text-based PDF resume. Scanned (image-only) PDFs have no text
 * layer; for those the call falls back to general questions about the job role.
 */

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;
// The brain only needs the gist; long resumes are cut to keep prompts short and fast.
export const MAX_RESUME_CHARS = 12000;
// Below this many letters the text is treated as unreadable (e.g. a scan with a few OCR crumbs).
const MIN_READABLE_LETTERS = 150;

export class ResumeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ResumeError';
    this.status = status;
  }
}

/** True when the bytes start with the PDF signature "%PDF-". */
export function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}

/** Collapses whitespace and strips control characters left by PDF extraction. */
export function cleanResumeText(text) {
  return String(text || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * @param {Buffer} buffer PDF bytes
 * @returns {Promise<{ text: string, pages: number, readable: boolean, truncated: boolean }>}
 */
export async function extractResumeText(buffer) {
  if (!looksLikePdf(buffer)) throw new ResumeError('Please upload your resume as a PDF file.');
  if (buffer.length > MAX_RESUME_BYTES) throw new ResumeError('The resume is larger than 5 MB.');

  let pages = 0;
  let raw = '';
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const result = await extractText(pdf, { mergePages: true });
    pages = result.totalPages;
    raw = Array.isArray(result.text) ? result.text.join('\n') : result.text;
  } catch (err) {
    throw new ResumeError('This PDF could not be read. Please export it again as a standard PDF.');
  }

  const cleaned = cleanResumeText(raw);
  const letters = (cleaned.match(/\p{L}/gu) || []).length;
  const truncated = cleaned.length > MAX_RESUME_CHARS;
  return {
    text: truncated ? cleaned.slice(0, MAX_RESUME_CHARS) : cleaned,
    pages,
    readable: letters >= MIN_READABLE_LETTERS,
    truncated
  };
}
