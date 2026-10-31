/**
 * ─── The invite email ───────────────────────────────────────────────────────
 * Plain text and simple HTML (inline styles, works in Gmail and Outlook). Pure function.
 */

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// Subjects are one line; names come from HR's spreadsheet.
const oneLine = (s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim();

/**
 * @param {{ candidateName: string, jobRole: string, companyName?: string|null, link: string, expiresAt: Date, senderName?: string|null }} input
 * @returns {{ subject: string, text: string, html: string }}
 */
export function buildInviteEmail({ candidateName, jobRole, companyName, link, expiresAt, senderName }) {
  const first = oneLine(candidateName).split(/\s+/)[0] || 'there';
  const role = oneLine(jobRole);
  const company = oneLine(companyName);
  const at = company ? ` at ${company}` : '';
  const until = expiresAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  const sender = oneLine(senderName) || (company ? `${company} Hiring Team` : 'The Hiring Team');

  const subject = `Your screening for ${role}${at}: start here`;
  const steps = [
    'Open the link on a laptop or phone with Chrome and a working microphone.',
    'Upload your resume as a PDF.',
    'Answer a few questions by voice, in English, Hindi or Hinglish. It takes about 5 minutes.'
  ];

  const text = [
    `Hi ${first},`,
    '',
    `Thank you for applying for the ${role} role${at}. The next step is a short voice screening with our AI assistant.`,
    '',
    'Start your screening:',
    link,
    '',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    '',
    `This link is personal to you; please do not forward it. It works until ${until}.`,
    'If anything does not work, just reply to this email.',
    '',
    sender
  ].join('\n');

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f4;font-family:Arial,Helvetica,sans-serif;color:#111">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e2e2;border-radius:8px">
    <tr><td style="padding:28px 28px 8px">
      <p style="margin:0 0 16px;font-size:16px">Hi ${escapeHtml(first)},</p>
      <p style="margin:0 0 16px;font-size:15px;line-height:1.5">Thank you for applying for the <strong>${escapeHtml(role)}</strong> role${company ? ` at <strong>${escapeHtml(company)}</strong>` : ''}. The next step is a short voice screening with our AI assistant.</p>
      <p style="margin:24px 0"><a href="${escapeHtml(link)}" style="display:inline-block;background:#111;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-size:15px;font-weight:bold">Start my screening</a></p>
      <ol style="margin:0 0 16px;padding-left:20px;font-size:14px;line-height:1.6;color:#333">
        ${steps.map(s => `<li>${escapeHtml(s)}</li>`).join('\n        ')}
      </ol>
      <p style="margin:0 0 8px;font-size:13px;color:#555">This link is personal to you; please do not forward it. It works until ${escapeHtml(until)}.</p>
      <p style="margin:0 0 8px;font-size:13px;color:#555">Button not working? Copy this address into your browser:<br><span style="word-break:break-all">${escapeHtml(link)}</span></p>
      <p style="margin:16px 0 0;font-size:13px;color:#555">If anything does not work, just reply to this email.</p>
    </td></tr>
    <tr><td style="padding:16px 28px 28px;font-size:14px">${escapeHtml(sender)}</td></tr>
  </table>
</body></html>`;

  return { subject, text, html };
}
