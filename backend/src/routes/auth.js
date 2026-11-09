import crypto from 'crypto';
import { Router } from 'express';
import db, { createAuthClient } from '../config/db.js';
import { requireAuth, getRole, isHr, clearRoleCache, ROLES } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { DEMO_LIMITS } from '../services/workspaceLimits.js';
import { appUrl, createInviteSession } from '../services/candidateInvites.js';
import { verifyInviteToken, emailTag, InviteTokenError } from '../services/inviteToken.js';

const router = Router();
// Sign-in answers carry session tokens: no browser or proxy may keep a copy.
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function notConfigured(res) {
  return res.status(503).json({ error: 'Auth not configured', message: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.' });
}

/**
 * POST /api/auth/login  (HR team: Admin and Recruiter)
 * Checks the email/password with Supabase Auth and returns the session token and role.
 * HR can also sign in with Google (POST /api/auth/google/hr-token).
 * Candidates sign in with Google or an email code instead.
 */
router.post('/login', limits.loginIp, limits.loginEmail, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (typeof email !== 'string' || typeof password !== 'string' || !email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const authClient = createAuthClient();
    if (!authClient) return notConfigured(res);

    // Separate client: signing in on db.supabase would make all later queries run as this user.
    const authAttempt = await authClient.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (authAttempt.error || !authAttempt.data?.session) {
      return res.status(401).json({ error: 'Invalid credentials. No account matches this email and password.' });
    }

    const { user, session } = authAttempt.data;
    const role = await getRole(user.id);
    if (!isHr(role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'This sign-in is for the HR team. Candidates use "Continue with Google" or an email code.' });
    }
    res.json({ success: true, token: session.access_token, user: { id: user.id, email: user.email, role } });
  } catch (err) {
    console.error('[POST /api/auth/login] Error:', err);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

// ── Candidate sign-in: Google, or a 6-digit code by email ──

let googleCheck = { at: 0, enabled: false };

/** Asks Supabase whether the Google provider is switched on (cached for a minute). */
async function googleEnabled() {
  if (Date.now() - googleCheck.at < 60 * 1000) return googleCheck.enabled;
  let enabled = false;
  try {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
    const res = await fetch(`${(process.env.SUPABASE_URL || '').replace(/\/+$/, '')}/auth/v1/settings`, { headers: { apikey: key } });
    const body = await res.json().catch(() => null);
    enabled = body?.external?.google === true;
  } catch { /* treated as not enabled */ }
  googleCheck = { at: Date.now(), enabled };
  return enabled;
}

/** The OAuth client ID of Google's sign-in button (the same one set in Supabase → Auth → Google). */
function googleClientId() {
  const id = (process.env.GOOGLE_CLIENT_ID || '').trim();
  return /^[\w.-]+\.apps\.googleusercontent\.com$/.test(id) ? id : '';
}

/**
 * GET /api/auth/google → { enabled, client_id }
 * Candidates sign in with Google's own button on this page (Google Identity Services), so the
 * Supabase project address is never shown. Needs GOOGLE_CLIENT_ID and the Google provider on in Supabase.
 */
router.get('/google', async (req, res) => {
  if (!process.env.SUPABASE_URL) return notConfigured(res);
  const clientId = googleClientId();
  const enabled = Boolean(clientId) && await googleEnabled();
  res.json({ enabled, client_id: enabled ? clientId : null });
});

/** The email inside a Google ID token, read without checking it (only to refuse early; Supabase checks the token). */
export function unverifiedGoogleEmail(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

/** True when the body has a well-formed Google ID token and nonce (checked again by Supabase). */
function validGoogleBody(credential, nonce) {
  return typeof credential === 'string' && credential.length <= 4096 && credential.split('.').length === 3
    && typeof nonce === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(nonce);
}

/**
 * POST /api/auth/google/token { credential, nonce } → { token, user }
 * credential = the ID token from Google's button; nonce = the random value whose SHA-256 the button
 * was given (so a token taken from elsewhere cannot be replayed here). Only for emails HR added to a
 * live campaign, and never for HR accounts; every refusal is the same 401.
 */
router.post('/google/token', limits.googleIp, async (req, res) => {
  try {
    const credential = req.body?.credential;
    const nonce = req.body?.nonce;
    if (!validGoogleBody(credential, nonce)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Google sign-in did not complete. Please try again.' });
    }
    if (!googleClientId()) return res.status(503).json({ error: 'Not configured', message: 'Google sign-in is not set up. Use the email code.' });

    // Every refusal looks the same, so a made-up token cannot be used to learn whether an email has
    // a screening or belongs to HR (the email is read before the token is checked).
    const refuse = () => res.status(401).json({
      error: 'Unauthorized',
      message: 'We could not sign you in with this Google account. Use the Google account of the email HR invited, or get a code by email.'
    });
    const email = unverifiedGoogleEmail(credential);
    if (!email) return refuse();
    const profile = await db.getProfileByEmail(email);
    // HR accounts never sign in here; and only emails in a live campaign, so strangers get no account.
    if (isHr(profile?.role) || !(await db.hasLiveScreening(email))) return refuse();

    const session = await db.signInWithGoogleIdToken(credential, nonce);
    // Supabase checked the signature, audience and nonce; the email it signed in must be the one checked above.
    if (!session || session.user.email?.toLowerCase() !== email) return refuse();
    await db.claimCandidatesByEmail(session.user.id, session.user.email);
    res.json({ success: true, token: session.accessToken, user: { id: session.user.id, email: session.user.email, role: await getRole(session.user.id) } });
  } catch (err) {
    console.error('[POST /api/auth/google/token] Error:', err.message);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

/**
 * POST /api/auth/google/hr-token { credential, nonce } → { token, user }
 * HR team sign-in with Google. Only for HR accounts an Admin has already added on the Team page:
 * the Google account's email must match one. Supabase links Google to that existing account on the
 * first sign-in, so a newly added member needs no password. Anyone else is refused before any
 * account is made, and every refusal is the same 401.
 */
router.post('/google/hr-token', limits.googleIp, async (req, res) => {
  try {
    const credential = req.body?.credential;
    const nonce = req.body?.nonce;
    if (!validGoogleBody(credential, nonce)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Google sign-in did not complete. Please try again.' });
    }
    if (!googleClientId()) return res.status(503).json({ error: 'Not configured', message: 'Google sign-in is not set up. Use your email and password.' });

    const refuse = () => res.status(401).json({
      error: 'Unauthorized',
      message: 'This Google account is not on the HR team. Ask your Admin to add your work email on the Team page.'
    });
    const email = unverifiedGoogleEmail(credential);
    if (!email) return refuse();
    const profile = await db.getProfileByEmail(email);
    if (!isHr(profile?.role)) return refuse();

    const session = await db.signInWithGoogleIdToken(credential, nonce);
    // Supabase checked the signature, audience and nonce. The signed-in account must be the very HR
    // account found above (same id), not merely an account with the same email.
    if (!session || session.user.id !== profile.id || session.user.email?.toLowerCase() !== email) return refuse();
    clearRoleCache(profile.id);
    const role = await getRole(profile.id);
    if (!isHr(role)) return refuse();
    res.json({ success: true, token: session.accessToken, user: { id: profile.id, email: session.user.email, role } });
  } catch (err) {
    console.error('[POST /api/auth/google/hr-token] Error:', err.message);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

// ── HR sign-up with Google ──
// Anyone who signs in with Google can create their own demo workspace and becomes its HR lead
// (never an Admin). Google sign-in keeps bots out; demo limits and a total cap keep costs bounded.
// Who may sign up (HR_SIGNUP and HR_SIGNUP_CODE in the environment):
//   open  default: anyone, with "Continue with Google" on the HR sign-in tab
//   code  HR_SIGNUP_CODE set: only through <app>/login?signup=<HR_SIGNUP_CODE>
//   off   HR_SIGNUP=off: nobody

const SIGNUP_CODE_MIN_LENGTH = 16;

/** The sign-up code from the environment; empty unless it is long enough to be unguessable. */
function signupCode() {
  const code = (process.env.HR_SIGNUP_CODE || '').trim();
  return code.length >= SIGNUP_CODE_MIN_LENGTH ? code : '';
}

/** 'open' | 'code' | 'off' (see above). */
export function signupMode() {
  if ((process.env.HR_SIGNUP || '').trim().toLowerCase() === 'off') return 'off';
  const raw = (process.env.HR_SIGNUP_CODE || '').trim();
  // A code that is set but too short to be safe closes sign-up rather than opening it.
  if (raw && !signupCode()) return 'off';
  return signupCode() ? 'code' : 'open';
}

/** Whether a sign-up with this code (may be empty) is allowed right now. */
function signupAllowed(code) {
  const mode = signupMode();
  return mode === 'open' || (mode === 'code' && signupCodeMatches(code));
}

/** Compares in constant time (hashes first, so lengths do not leak either). */
function signupCodeMatches(given) {
  const expected = signupCode();
  if (!expected || typeof given !== 'string' || given.length > 256) return false;
  const hash = (v) => crypto.createHash('sha256').update(v).digest();
  return crypto.timingSafeEqual(hash(given), hash(expected));
}

/** How many sign-up workspaces may exist in total (a backstop if the link is shared too widely). */
function maxDemoWorkspaces() {
  const n = Number(process.env.MAX_DEMO_WORKSPACES ?? 25);
  return Number.isInteger(n) && n >= 0 ? n : 25;
}

/** The name in a Google ID token (read after Supabase has checked the token). */
function googleName(idToken) {
  try {
    const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1] || '', 'base64url').toString('utf8'));
    return typeof payload?.name === 'string' ? payload.name.trim().slice(0, 120) : '';
  } catch {
    return '';
  }
}

/**
 * GET /api/auth/hr-signup[?code=…] → { open, valid }
 *   open  : anyone may sign up from the HR tab (no code needed)
 *   valid : signing up with this code (or none, when open) works right now
 */
router.get('/hr-signup', limits.signupCheckIp, async (req, res) => {
  const ready = Boolean(googleClientId()) && Boolean(process.env.SUPABASE_URL) && await googleEnabled();
  const code = typeof req.query?.code === 'string' ? req.query.code : '';
  res.json({ open: ready && signupMode() === 'open', valid: ready && signupAllowed(code) });
});

/**
 * POST /api/auth/google/hr-signup { credential, nonce, code?, workspace_name? } → { token, user, workspace }
 * Creates a new demo workspace (with usage limits) and makes this Google account its HR lead.
 * Someone who already has an HR account is simply signed in. Emails used for a candidate screening
 * cannot sign up, so one person is never both candidate and HR.
 */
router.post('/google/hr-signup', limits.signupIp, async (req, res) => {
  try {
    const { credential, nonce, code } = req.body || {};
    if (!validGoogleBody(credential, nonce)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Google sign-in did not complete. Please try again.' });
    }
    if (!signupAllowed(code)) {
      return res.status(403).json({
        error: 'Forbidden',
        message: signupMode() === 'off'
          ? 'New sign-ups are closed right now.'
          : 'This sign-up link is not valid. Ask the person who shared it for a new one.'
      });
    }
    if (!googleClientId()) return res.status(503).json({ error: 'Not configured', message: 'Google sign-in is not set up on this site.' });
    const rawName = typeof req.body?.workspace_name === 'string' ? req.body.workspace_name.trim() : '';
    if (rawName.length > 120) return res.status(400).json({ error: 'Bad Request', message: 'Keep the workspace name under 120 characters.' });

    const refuse = () => res.status(401).json({ error: 'Unauthorized', message: 'We could not sign you in with this Google account. Please try again.' });
    const email = unverifiedGoogleEmail(credential);
    if (!email) return refuse();
    if ((await db.listCandidatesByEmail(email)).length) {
      return res.status(409).json({ error: 'Conflict', message: 'This email is used for a candidate screening here. Please sign up with a different Google account.' });
    }
    const existing = await db.getProfileByEmail(email);
    if (!isHr(existing?.role) && (await db.countWorkspaces({ kind: 'demo' })) >= maxDemoWorkspaces()) {
      return res.status(503).json({ error: 'Sign-ups paused', message: 'New sign-ups are paused right now. Please contact the person who shared this link.' });
    }

    const session = await db.signInWithGoogleIdToken(credential, nonce);
    if (!session || session.user.email?.toLowerCase() !== email) return refuse();

    // Already on an HR team (or a double click finished first): just sign them in.
    const profile = await db.getProfile(session.user.id);
    if (isHr(profile?.role) && profile.workspace_id) {
      return res.json({ success: true, token: session.accessToken, user: { id: session.user.id, email, role: profile.role }, workspace: null });
    }

    const name = (profile?.name || googleName(credential) || email.split('@')[0]).slice(0, 120);
    const workspace = await db.createWorkspace({ name: rawName || `${name}'s workspace`, kind: 'demo', ...DEMO_LIMITS, created_by: session.user.id });
    await db.updateProfile(session.user.id, { role: ROLES.HR_LEAD, workspace_id: workspace.id, name });
    clearRoleCache(session.user.id);
    res.status(201).json({
      success: true, token: session.accessToken,
      user: { id: session.user.id, email, role: ROLES.HR_LEAD },
      workspace: { id: workspace.id, name: workspace.name }
    });
  } catch (err) {
    console.error('[POST /api/auth/google/hr-signup] Error:', err.message);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

/**
 * POST /api/auth/email-code { email } → sends a 6-digit sign-in code.
 * Only for emails HR has added to a live campaign, so random addresses cannot create accounts.
 */
router.post('/email-code', limits.codeIp, limits.codeEmail, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Bad Request', message: 'Enter a valid email address.' });
    const authClient = createAuthClient();
    if (!authClient) return notConfigured(res);

    const profile = await db.getProfileByEmail(email);
    if (isHr(profile?.role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'This email belongs to the HR team. Use the HR sign-in.' });
    }
    if (!(await db.hasLiveScreening(email))) {
      return res.status(404).json({ error: 'Not Found', message: 'No screening found for this email. Check with HR that they added this exact address and ran the campaign.' });
    }

    const { error } = await authClient.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: `${appUrl(req)}/invite` }
    });
    if (error) {
      const limited = error.status === 429 || /rate limit|security purposes/i.test(error.message);
      return res.status(limited ? 429 : 502).json({
        error: limited ? 'Too Many Requests' : 'Bad Gateway',
        message: limited ? 'Too many codes were requested. Wait a minute and try again.' : `Could not send the code: ${error.message}`
      });
    }
    res.json({ sent: true, message: `We sent a 6-digit code to ${email}.` });
  } catch (err) {
    console.error('[POST /api/auth/email-code] Error:', err);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

/** POST /api/auth/email-code/verify { email, code } → { token, user } for the candidate. */
router.post('/email-code/verify', limits.verifyIp, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '').replace(/\s+/g, '');
    if (!EMAIL_RE.test(email) || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: 'Bad Request', message: 'Enter your email and the 6-digit code.' });
    }
    const authClient = createAuthClient();
    if (!authClient) return notConfigured(res);

    const { data, error } = await authClient.auth.verifyOtp({ email, token: code, type: 'email' });
    if (error || !data?.session) {
      return res.status(401).json({ error: 'Unauthorized', message: 'That code is wrong or has expired. Request a new one.' });
    }
    await db.claimCandidatesByEmail(data.user.id, data.user.email);
    res.json({ success: true, token: data.session.access_token, user: { id: data.user.id, email: data.user.email, role: await getRole(data.user.id) } });
  } catch (err) {
    console.error('[POST /api/auth/email-code/verify] Error:', err);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

/**
 * POST /api/auth/join { token } → { token, user }
 * The candidate opened their personal link (<app>/join?t=..., from the invite email or from HR).
 * The invite token is checked and the candidate is signed in on the server, so the emailed link
 * keeps working (a Supabase magic link in the email would expire in an hour or be used up by mail
 * scanners) and the browser never goes to the Supabase address.
 */
router.post('/join', limits.joinIp, limits.joinToken, async (req, res) => {
  try {
    let candidateId;
    let sentTo;
    try {
      ({ candidateId, emailTag: sentTo } = verifyInviteToken(req.body?.token));
    } catch (err) {
      if (!(err instanceof InviteTokenError)) throw err;
      const status = err.reason === 'expired' ? 410 : err.reason === 'not_configured' ? 503 : 400;
      return res.status(status).json({ error: 'Invalid link', message: err.message });
    }
    if (!db.isConfigured) return notConfigured(res);

    const candidate = await db.getCandidate(candidateId);
    if (!candidate) return res.status(404).json({ error: 'Not Found', message: 'This screening no longer exists. Please contact the HR team.' });
    // HR changed the candidate's email after this link was sent: only the newest email's link works.
    if (sentTo !== emailTag(candidate.email)) {
      return res.status(410).json({ error: 'Invalid link', message: 'This invite link has been replaced. Use the newest invite email, or ask HR to send it again.' });
    }
    if (candidate.batch?.status !== 'live') {
      return res.status(409).json({
        error: 'Conflict',
        message: candidate.batch?.status === 'closed' ? 'This screening is closed. Please contact the HR team.' : 'This screening has not started yet. Please try again later.'
      });
    }
    const session = await createInviteSession(candidate);
    res.json({ success: true, token: session.accessToken, user: { id: session.user.id, email: session.user.email, role: await getRole(session.user.id) } });
  } catch (err) {
    if (err?.status === 409) return res.status(409).json({ error: 'Conflict', message: err.message });
    console.error('[POST /api/auth/join] Error:', err);
    res.status(500).json({ error: 'Server Error', message: 'Could not open the screening. Please try the link again in a minute.' });
  }
});

/**
 * GET /api/auth/me
 * The signed-in user. Candidates are first linked to the screenings HR added for their email,
 * then get their current candidate record and campaign.
 */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const me = { id: req.user.id, email: req.user.email, role: req.user.role, name: null };
    if (!db.isConfigured) return res.json(me);

    if (req.user.role === ROLES.CANDIDATE) {
      await db.claimCandidatesByEmail(req.user.id, req.user.email);
      const candidate = await db.getCandidateForUser(req.user.id);
      me.name = candidate?.name || null;
      me.candidate = candidate
        ? { id: candidate.id, name: candidate.name, status: candidate.status, batch: candidate.batch }
        : null;
    } else {
      me.name = (await db.getProfile(req.user.id))?.name || null;
    }
    res.json(me);
  } catch (err) {
    next(err);
  }
});

export default router;
