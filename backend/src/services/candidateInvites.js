import db from '../config/db.js';
import { HR_ROLES } from '../middleware/auth.js';
import { sendMail, isMailConfigured } from './mailer.js';
import { createInviteToken } from './inviteToken.js';
import { buildInviteEmail } from './inviteEmail.js';
import { withEmailAllowance } from './workspaceLimits.js';

/**
 * ─── Getting candidates into their screening ────────────────────────────────
 * Both ways in give the candidate a personal /join link on the app's own address:
 *  - HR copies it (POST /api/hr/candidates/:id/invite-link), or
 *  - the app emails it when the campaign runs.
 * Opening it calls POST /api/auth/join, which signs the candidate in on the server
 * (createInviteSession). The browser is never sent to the <project>.supabase.co address.
 */

/** Where links land. PUBLIC_APP_URL wins; otherwise the address in use. */
export function appUrl(req) {
  const configured = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

export class InviteError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'InviteError';
    this.status = status;
  }
}

async function refuseHrEmail(email) {
  const existing = await db.getProfileByEmail(email);
  if (HR_ROLES.includes(existing?.role)) {
    throw new InviteError('This email belongs to an HR account. Use a different candidate email.', 409);
  }
}

/**
 * The candidate's personal /join link (signed, expires after INVITE_LINK_DAYS), the same one the
 * invite email holds. It names only the app's own address.
 * @param {{ id: string, email: string }} candidate
 * @param {string} baseUrl
 */
export async function createInviteLink(candidate, baseUrl) {
  // Never hand out a link that signs someone in as an HR account.
  await refuseHrEmail(candidate.email);
  const { token } = createInviteToken(candidate.id, candidate.email);
  return `${baseUrl}/join?t=${encodeURIComponent(token)}`;
}

/**
 * Signs the candidate in on the server: creates (or reuses) their login with a one-time magic link
 * and uses that link's token right here. Returns the session token for the browser to keep.
 * @param {{ id: string, email: string, name: string, user_id?: string|null }} candidate
 * @returns {Promise<{ accessToken: string, user: { id: string, email: string } }>}
 */
export async function createInviteSession(candidate) {
  await refuseHrEmail(candidate.email);
  // generateLink creates the auth user on first use; the profiles trigger makes it a candidate.
  const { data, error } = await db.supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: candidate.email,
    options: { data: { name: candidate.name } }
  });
  if (error) throw error;
  if (candidate.user_id !== data.user.id) {
    await db.linkCandidateUser(candidate.id, data.user.id);
  }
  return db.exchangeLinkToken(data.properties.hashed_token);
}

/** "Saral (Hiring) <me@gmail.com>" → "Saral (Hiring)". */
function senderName() {
  const from = (process.env.MAIL_FROM || '').trim();
  const m = from.match(/^"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : null;
}

/**
 * Emails one candidate their personal /join link and records the result on the candidate row.
 * @param {{ id: string, name: string, email: string }} candidate
 * @param {{ job_role: string, company_name?: string|null, workspace_id?: string }} batch
 * @param {string} baseUrl
 * @returns {Promise<{ sent: boolean, error?: string }>}
 */
export async function sendInviteEmail(candidate, batch, baseUrl) {
  try {
    await refuseHrEmail(candidate.email);
    const { token, expiresAt } = createInviteToken(candidate.id, candidate.email);
    const link = `${baseUrl}/join?t=${encodeURIComponent(token)}`;
    const email = buildInviteEmail({ candidateName: candidate.name, jobRole: batch.job_role, companyName: batch.company_name, link, expiresAt, senderName: senderName() });
    // A demo workspace may send only so many invite emails a day (they go out from the app's mailbox).
    await withEmailAllowance(batch.workspace_id, async () => {
      await sendMail({ to: candidate.email, ...email });
      await db.markInviteEmail(candidate.id, { invite_email_sent_at: new Date().toISOString(), invite_email_error: null });
    });
    return { sent: true };
  } catch (err) {
    const error = String(err?.message || err).slice(0, 300);
    await db.markInviteEmail(candidate.id, { invite_email_error: error }).catch(() => {});
    return { sent: false, error };
  }
}

// A personal mailbox accepts a couple of messages at a time; more get refused or flagged.
const EMAIL_CONCURRENCY = 2;

/** Background email jobs still running (tests wait for them). */
export const runningInviteJobs = new Set();

/**
 * Emails every candidate in `candidates` who has not been emailed yet, in the background.
 * Finished candidates are skipped. Returns at once with how many were queued.
 * @returns {{ configured: boolean, queued: number, done: Promise<{ sent: number, failed: number }> }}
 */
export function queueInviteEmails(batch, candidates, baseUrl) {
  if (!isMailConfigured()) return { configured: false, queued: 0, done: Promise.resolve({ sent: 0, failed: 0 }) };
  const todo = candidates.filter(c => !c.invite_email_sent_at && c.status !== 'completed');
  const result = { sent: 0, failed: 0 };
  const queue = [...todo];
  const worker = async () => {
    for (let c = queue.shift(); c; c = queue.shift()) {
      const r = await sendInviteEmail(c, batch, baseUrl);
      if (r.sent) result.sent += 1; else result.failed += 1;
    }
  };
  const done = Promise.all(Array.from({ length: Math.min(EMAIL_CONCURRENCY, todo.length) }, worker))
    .then(() => result)
    .catch(err => { console.error(`[Invites ${batch.id}] Email job failed:`, err.message); return result; })
    .finally(() => runningInviteJobs.delete(done));
  if (todo.length) runningInviteJobs.add(done);
  return { configured: true, queued: todo.length, done };
}
