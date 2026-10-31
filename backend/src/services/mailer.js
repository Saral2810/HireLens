import nodemailer from 'nodemailer';
import dotenv from 'dotenv';

dotenv.config();

/**
 * ─── Outgoing email (SMTP) ──────────────────────────────────────────────────
 * Invite emails go out from your own mailbox or any SMTP provider, not from Supabase.
 *
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
  const c = config();
  return Boolean(c.host && c.user && c.pass && c.from);
}

/** Tests only: route every email to a fake transport ({ sendMail(message) }). Pass null to remove it. */
export function useTestTransport(fake) {
  testTransport = fake;
}

function getTransport() {
  if (testTransport) return testTransport;
  // Tests must never reach a real mail server.
  if (process.env.NODE_ENV === 'test') throw new MailError('Real email is disabled while tests run.');
  if (!isMailConfigured()) throw new MailError('Email is not set up. Add SMTP_HOST, SMTP_USER, SMTP_PASS and MAIL_FROM to .env.');
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
    throw new MailError(auth
      ? 'The mail server refused the login. For Gmail, SMTP_PASS must be an App Password.'
      : `Could not send the email: ${String(err?.message || err).slice(0, 200)}`);
  }
}
