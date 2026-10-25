// Writes a minimal one-page, text-based PDF (Helvetica, ASCII text). Used to make made-up
// resumes for tests and the contest demo, without a PDF library.

function escapePdfText(s) {
  return String(s).replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');
}

/**
 * @param {string[]} lines text lines, top to bottom (about 50 fit on the page)
 * @returns {Buffer} PDF bytes
 */
export function makeTextPdf(lines) {
  const content = [
    'BT', '/F1 11 Tf', '14 TL', '50 790 Td',
    ...lines.map(l => `(${escapePdfText(l)}) '`),
    'ET'
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}
