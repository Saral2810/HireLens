import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * ─── Outgoing email ──────────────────────────────────────────────────────────
 * Invite emails go out from your own mailbox (SMTP) or an email API, not from Supabase.
 *
 *   MAIL_PROVIDER smtp | brevo | resend. Blank = brevo if BREVO_API_KEY is set, resend if
 *                 RESEND_API_KEY is set, else smtp. Hosts that block SMTP ports (Render's free
 *                 plan) need brevo or resend: those send over HTTPS.
 *   BREVO_API_KEY  Brevo → SMTP & API → API keys. MAIL_FROM must be a sender verified in Brevo.
 *   RESEND_API_KEY Resend → API keys. MAIL_FROM must be on a domain verified in Resend.
 *
 * SMTP (the default, e.g. with ngrok on your own computer):
 *   SMTP_HOST     smtp.gmail.com for a personal Gmail (or your provider's host)
 *   SMTP_PORT     465 (SSL) or 587 (STARTTLS)
 *   SMTP_USER     the mailbox login, e.g. you@gmail.com
 *   SMTP_PASS     for Gmail: an App Password (Google Account → Security → 2-Step Verification → App passwords)
 *   MAIL_FROM     what candidates see, e.g. "Saral (Hiring) <you@gmail.com>". Gmail requires your own address.
 *   MAIL_REPLY_TO optional reply address
 */

export class MailError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MailError';
  }
}

let transport = null;
let testTransport = null;
let testFetch = null;

/** Which way email goes out: 'smtp', 'brevo' or 'resend'. */
export function mailProvider() {
  const chosen = (process.env.MAIL_PROVIDER || '').trim().toLowerCase();
  if (['smtp', 'brevo', 'resend'].includes(chosen)) return chosen;
  if ((process.env.BREVO_API_KEY || '').trim()) return 'brevo';
  if ((process.env.RESEND_API_KEY || '').trim()) return 'resend';
  return 'smtp';
}

const API_KEY_VAR = { brevo: 'BREVO_API_KEY', resend: 'RESEND_API_KEY' };

/** What is still missing for the chosen provider, e.g. ['BREVO_API_KEY']. */
export function missingMailSettings() {
  const provider = mailProvider();
  const c = config();
  const missing = provider === 'smtp'
    ? [['SMTP_HOST', c.host], ['SMTP_USER', c.user], ['SMTP_PASS', c.pass]].filter(([, v]) => !v).map(([k]) => k)
    : (process.env[API_KEY_VAR[provider]] || '').trim() ? [] : [API_KEY_VAR[provider]];
  if (!c.from) missing.push('MAIL_FROM');
  return missing;
}

/** "Saral (Hiring) <me@gmail.com>" → { name: 'Saral (Hiring)', email: 'me@gmail.com' }. */
function parseAddress(value) {
  const m = String(value).match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: String(value).trim() };
}

/** Email APIs (HTTPS, port 443) with the same sendMail() shape as a nodemailer transport. */
function httpTransport(provider) {
  const key = (process.env[API_KEY_VAR[provider]] || '').trim();
  const request = provider === 'brevo'
    ? (m) => ({
      url: 'https://api.brevo.com/v3/smtp/email',
      headers: { 'api-key': key },
      body: {
        sender: parseAddress(m.from), to: [{ email: m.to }], subject: m.subject, textContent: m.text, htmlContent: m.html,
        ...(m.replyTo ? { replyTo: parseAddress(m.replyTo) } : {})
      }
    })
    : (m) => ({
      url: 'https://api.resend.com/emails',
      headers: { Authorization: `Bearer ${key}` },
      body: { from: m.from, to: [m.to], subject: m.subject, text: m.text, html: m.html, ...(m.replyTo ? { reply_to: m.replyTo } : {}) }
    });
  return {
    async sendMail(message) {
      const { url, headers, body } = request(message);
      const res = await (testFetch || fetch)(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(`${provider} answered ${res.status}: ${data.message || data.code || data.name || res.statusText}`);
        err.status = res.status;
        throw err;
      }
      return { messageId: data.messageId || data.id || null };
    }
  };
}

function config() {
  const port = Number(process.env.SMTP_PORT || 465);
  return {
    host: (process.env.SMTP_HOST || '').trim(),
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    user: (process.env.SMTP_USER || '').trim(),
    pass: process.env.SMTP_PASS || '',
    from: (process.env.MAIL_FROM || process.env.SMTP_USER || '').trim(),
    replyTo: (process.env.MAIL_REPLY_TO || '').trim() || undefined
  };
}

export function isMailConfigured() {
  if (testTransport) return true;
  return missingMailSettings().length === 0;
}

/** Tests only: route every email to a fake transport ({ sendMail(message) }). Pass null to remove it. */
export function useTestTransport(fake) {
  testTransport = fake;
}

/** Tests only: a fake fetch(url, init) for the email APIs (Brevo, Resend). Pass null to remove it. */
export function useTestFetch(fake) {
  testFetch = fake;
}

function getTransport() {
  if (testTransport) return testTransport;
  // Tests must never reach a real mail server; email APIs run only against a fake fetch.
  const fakeApi = testFetch && mailProvider() !== 'smtp';
  if (process.env.NODE_ENV === 'test' && !fakeApi) throw new MailError('Real email is disabled while tests run.');
  if (!isMailConfigured()) throw new MailError(`Email is not set up. Add ${missingMailSettings().join(', ')} to .env.`);
  // Email APIs keep no connection, so there is nothing to reuse.
  if (mailProvider() !== 'smtp') return httpTransport(mailProvider());
  if (!transport) {
    const c = config();
    transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass },
      // A stuck mail server must not hold a send forever.
      connectionTimeout: 15000, greetingTimeout: 10000, socketTimeout: 20000,
      // Personal mailboxes refuse many parallel connections.
      pool: true, maxConnections: 2
    });
  }
  return transport;
}

/**
 * Sends one email.
 * @param {{ to: string, subject: string, text: string, html: string }} message
 * @returns {Promise<{ messageId: string|null }>}
 */
export async function sendMail({ to, subject, text, html }) {
  const c = config();
  try {
    const info = await getTransport().sendMail({ from: c.from, replyTo: c.replyTo, to, subject, text, html });
    return { messageId: info?.messageId || null };
  } catch (err) {
    if (err instanceof MailError) throw err;
    // Login failures are the common case with Gmail (normal password instead of an App Password).
    const auth = err?.code === 'EAUTH' || err?.responseCode === 535;
    if (auth) throw new MailError('The mail server refused the login. For Gmail, SMTP_PASS must be an App Password.');
    if (err?.status === 401 || err?.status === 403) {
      throw new MailError(`The ${mailProvider()} API refused the key or the sender. Check ${API_KEY_VAR[mailProvider()]} and that MAIL_FROM is a verified sender.`);
    }
    // SMTP ports blocked by the host (Render's free plan): the connection just times out.
    const blocked = ['ETIMEDOUT', 'ECONNREFUSED', 'ESOCKET', 'ECONNECTION'].includes(err?.code);
    throw new MailError(blocked
      ? `Could not reach the mail server (${err.code}). If this host blocks SMTP, set BREVO_API_KEY instead.`
      : `Could not send the email: ${String(err?.message || err).slice(0, 200)}`);
  }
}
