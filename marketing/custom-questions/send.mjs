// Sends the Custom Questions feature email through Brevo's transactional email API.
// One email per address (recipients never see each other).
//
//   MAIL_FROM='HireLens <agent@yourdomain.com>' node marketing/custom-questions/send.mjs a@x.com b@y.com
//   add --dry-run to print what would be sent without sending.
//
// Needs BREVO_API_KEY (or a proxy that adds the api-key header) and MAIL_FROM set to a sender
// verified in Brevo. Optional: VIDEO_URL (the clip with voiceover), MAIL_REPLY_TO.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = 'https://raw.githubusercontent.com/Saral2810/HireLens/coding_help/tender-gates-889gyp/marketing/custom-questions';
const LINKS = {
  GIF_URL: `${BASE}/hirelens-custom-questions-v3.gif`,
  VIDEO_URL: process.env.VIDEO_URL || 'https://github.com/Saral2810/HireLens/blob/coding_help/tender-gates-889gyp/marketing/custom-questions/hirelens-custom-questions-v3.mp4',
  SITE_URL: 'https://hirelens-56td.onrender.com/login'
};
const SUBJECT = 'Check out the new feature update at HireLens: Custom Questions';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const to = args.filter(a => !a.startsWith('--'));
if (!to.length) { console.error('Give at least one recipient email.'); process.exit(1); }

const fill = (s) => s.replace(/{{(\w+)}}/g, (_, k) => LINKS[k] ?? `{{${k}}}`);
const html = fill(readFileSync(join(here, 'email.html'), 'utf8'));
const text = fill(`Still asking every candidate the same questions?

Meet Custom Questions: add questions tailored to your role, and our voice agent will ask them in every screening call.

Watch the quick demo: {{VIDEO_URL}}

Where to find it
1. Log in and click Campaigns > New campaign
2. On the Questions step, type your question and click Add
3. Click Continue, add candidates and run your campaign

Check it out now on HireLens: {{SITE_URL}}

Questions or feedback? Just reply to this email.
The HireLens team`);

function parseAddress(v) {
  const m = String(v).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: String(v).trim() };
}

const from = process.env.MAIL_FROM;
if (!from) { console.error('Set MAIL_FROM to the Brevo-verified sender, e.g. "HireLens <agent@yourdomain.com>".'); process.exit(1); }

for (const email of to) {
  const body = {
    sender: parseAddress(from), to: [{ email }], subject: SUBJECT, htmlContent: html, textContent: text,
    ...(process.env.MAIL_REPLY_TO ? { replyTo: parseAddress(process.env.MAIL_REPLY_TO) } : {}),
    tags: ['feature-custom-questions']
  };
  if (dryRun) { console.log(`[dry run] would send to ${email} from ${from}`); continue; }
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': process.env.BREVO_API_KEY || 'set-by-proxy', 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body)
  });
  const out = await res.text();
  console.log(`${email}: ${res.status} ${out}`);
  if (!res.ok) process.exitCode = 1;
}
