// npm run check:setup — run this before pressing "Run campaign". Checks, without sending anything:
//   1. PUBLIC_APP_URL is a public https address and the app answers there
//   2. the Gmail/SMTP login works (connects and logs in only)
//   3. invite links can be signed
// Optional: npm run check:setup -- --send-test you@gmail.com  sends one sample invite email to yourself.
// Uses no Gnani or LLM credits.
import dotenv from 'dotenv';
import nodemailer from 'nodemailer';
import { createInviteToken } from '../src/services/inviteToken.js';
import { buildInviteEmail } from '../src/services/inviteEmail.js';

dotenv.config();

let problems = 0;
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg, fix) => { problems += 1; console.log(`  ✗ ${msg}${fix ? `\n      → ${fix}` : ''}`); };

console.log('\n1. Public address');
const url = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
if (!url) bad('PUBLIC_APP_URL is empty.', 'Set it to https://your-name.ngrok-free.app in .env.');
else if (!url.startsWith('https://') || /localhost|127\.0\.0\.1/.test(url)) bad(`PUBLIC_APP_URL is ${url}.`, 'Candidates need a public https address (your ngrok domain).');
else {
  ok(`PUBLIC_APP_URL = ${url}`);
  try {
    // The header skips ngrok's free-plan warning page for this check.
    const res = await fetch(`${url}/health`, { headers: { 'ngrok-skip-browser-warning': '1' }, signal: AbortSignal.timeout(15000) });
    const body = await res.json().catch(() => null);
    if (res.ok && body?.database === 'connected') ok('The app answers at that address and the database is connected.');
    else bad(`The address answered ${res.status}${body ? ` (database: ${body.database})` : ''}.`, 'Start everything with: npm run public');
  } catch (err) {
    bad(`Nothing answers at ${url} (${err.message}).`, 'Start everything with: npm run public');
  }
}
console.log(`  • Supabase cannot be checked from here. In Supabase → Authentication → URL Configuration,\n    "Redirect URLs" must contain ${url ? `${url}/**` : 'https://your-name.ngrok-free.app/**'}`);

console.log('\n2. Email (SMTP)');
const smtp = {
  host: (process.env.SMTP_HOST || '').trim(), port: Number(process.env.SMTP_PORT || 465),
  user: (process.env.SMTP_USER || '').trim(), pass: process.env.SMTP_PASS || '', from: (process.env.MAIL_FROM || process.env.SMTP_USER || '').trim()
};
const missing = ['host', 'user', 'pass', 'from'].filter(k => !smtp[k]);
let transport = null;
if (missing.length) bad(`Missing in .env: ${missing.map(k => (k === 'from' ? 'MAIL_FROM' : `SMTP_${k.toUpperCase()}`)).join(', ')}`, 'See the "Invite emails" block in .env.example.');
else {
  transport = nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : smtp.port === 465,
    auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000
  });
  try {
    await transport.verify();
    ok(`Logged in to ${smtp.host} as ${smtp.user}. Emails will come from: ${smtp.from}`);
  } catch (err) {
    const auth = err?.code === 'EAUTH' || err?.responseCode === 535;
    bad(`Could not log in to ${smtp.host}: ${String(err.message).split('\n')[0]}`, auth ? 'For Gmail, SMTP_PASS must be a 16-letter App Password, not your normal password.' : 'Check SMTP_HOST and SMTP_PORT.');
    transport = null;
  }
}

console.log('\n3. Invite links');
try {
  createInviteToken('00000000-0000-4000-8000-000000000000', 'check@example.com');
  ok(process.env.INVITE_SECRET ? 'Signed with INVITE_SECRET.' : 'Signed with a key derived from the Supabase service key.');
} catch (err) {
  bad(err.message);
}

const testTo = process.argv[process.argv.indexOf('--send-test') + 1];
if (process.argv.includes('--send-test')) {
  console.log('\n4. Sample email');
  if (!testTo || !testTo.includes('@')) bad('Give an address: npm run check:setup -- --send-test you@gmail.com');
  else if (!transport) bad('Skipped: the email login above must work first.');
  else {
    // A sample with a dummy link: it shows the email exactly as candidates get it, but opens no screening.
    const email = buildInviteEmail({ candidateName: 'Sample Candidate', jobRole: 'Backend Engineer (sample)', companyName: null, link: `${url || 'https://example.com'}/join?t=sample`, expiresAt: new Date(Date.now() + 30 * 864e5), senderName: null });
    try {
      await transport.sendMail({ from: smtp.from, to: testTo, subject: `[Sample] ${email.subject}`, text: email.text, html: email.html });
      ok(`Sample invite sent to ${testTo}. Check the inbox (and Spam). Its button is a dummy link.`);
    } catch (err) {
      bad(`Sending failed: ${err.message}`);
    }
  }
}

transport?.close();
console.log(problems ? `\n${problems} thing(s) to fix before running a campaign.\n` : '\nAll set. Running a campaign will email every candidate their link.\n');
process.exit(problems ? 1 : 0);
