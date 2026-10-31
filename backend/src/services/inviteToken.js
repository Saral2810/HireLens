import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

/**
 * ─── Invite tokens for emailed links ────────────────────────────────────────
 * The email holds <app>/join?t=<token>. The token names one candidate row, the address it was sent to
 * (as a short hash) and an expiry date, and is signed with a server secret, so it cannot be guessed or
 * changed. If HR later corrects the candidate's email, links sent to the old address stop working.
 * Opening it creates a fresh one-time Supabase sign-in at that moment (see POST /api/auth/join), so the
 * email keeps working for days, unlike a Supabase magic link (one hour, one use, often used up by mail scanners).
 *
 *   INVITE_SECRET     optional; at least 32 characters. Without it a key is derived from the Supabase service key.
 *   INVITE_LINK_DAYS  how long emailed links work (default 30). Closing the campaign stops them sooner.
 */

export class InviteTokenError extends Error {
  /** @param {'invalid'|'expired'|'not_configured'} reason */
  constructor(reason, message) {
    super(message);
    this.name = 'InviteTokenError';
    this.reason = reason;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function secret() {
  const own = (process.env.INVITE_SECRET || '').trim();
  if (own.length >= 32) return own;
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
  if (service) return crypto.createHmac('sha256', service).update('hr-screening invite links v1').digest('hex');
  throw new InviteTokenError('not_configured', 'Invite links need INVITE_SECRET (32+ characters) or the Supabase service key in .env.');
}

export function inviteLinkDays() {
  const days = Number(process.env.INVITE_LINK_DAYS || 30);
  return Number.isFinite(days) && days > 0 ? Math.min(days, 90) : 30;
}

/** Short, non-reversible tag of an email address (the link carries this, not the address). */
export function emailTag(email) {
  return crypto.createHash('sha256').update(String(email || '').trim().toLowerCase()).digest('base64url').slice(0, 16);
}

const sign = (body) => b64url(crypto.createHmac('sha256', secret()).update(body).digest());

/**
 * @param {string} candidateId
 * @param {string} email the address the link is sent to
 * @param {{ now?: number, days?: number }} [opts]
 * @returns {{ token: string, expiresAt: Date }}
 */
export function createInviteToken(candidateId, email, { now = Date.now(), days = inviteLinkDays() } = {}) {
  const expiresAt = new Date(now + days * 24 * 60 * 60 * 1000);
  const body = b64url(JSON.stringify({ c: candidateId, m: emailTag(email), e: Math.floor(expiresAt.getTime() / 1000) }));
  return { token: `${body}.${sign(body)}`, expiresAt };
}

/**
 * @param {string} token
 * @param {{ now?: number }} [opts]
 * @returns {{ candidateId: string, emailTag: string, expiresAt: Date }}
 */
export function verifyInviteToken(token, { now = Date.now() } = {}) {
  const invalid = () => new InviteTokenError('invalid', 'This invite link is not valid. Use the link from your email, or ask HR for a new one.');
  if (typeof token !== 'string' || token.length > 512) throw invalid();
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined) throw invalid();
  const expected = Buffer.from(sign(body));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) throw invalid();

  let payload;
  try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw invalid(); }
  if (typeof payload?.c !== 'string' || typeof payload?.m !== 'string' || !Number.isInteger(payload?.e)) throw invalid();
  const expiresAt = new Date(payload.e * 1000);
  if (now > expiresAt.getTime()) throw new InviteTokenError('expired', 'This invite link has expired. Ask HR to send you a new one.');
  return { candidateId: payload.c, emailTag: payload.m, expiresAt };
}
