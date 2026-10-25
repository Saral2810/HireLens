import { Router } from 'express';
import db, { createAuthClient } from '../config/db.js';
import { requireAuth, getRole, isHr, ROLES } from '../middleware/auth.js';

const router = Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Where Supabase sends people back after Google sign-in. PUBLIC_APP_URL wins; otherwise the address in use. */
function appUrl(req) {
  const configured = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

function notConfigured(res) {
  return res.status(503).json({ error: 'Auth not configured', message: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.' });
}

/**
 * POST /api/auth/login  (HR team: Admin and Recruiter)
 * Checks the email/password with Supabase Auth and returns the session token and role.
 * Candidates sign in with Google or an email code instead.
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
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

/** GET /api/auth/google → { enabled, url }: the browser goes to url; Google sends it back signed in. */
router.get('/google', async (req, res) => {
  if (!process.env.SUPABASE_URL) return notConfigured(res);
  const enabled = await googleEnabled();
  const url = `${process.env.SUPABASE_URL.replace(/\/+$/, '')}/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`${appUrl(req)}/auth/callback`)}`;
  res.json({ enabled, url: enabled ? url : null });
});

/**
 * POST /api/auth/email-code { email } → sends a 6-digit sign-in code.
 * Only for emails HR has added to a live campaign, so random addresses cannot create accounts.
 */
router.post('/email-code', async (req, res) => {
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

    const { error } = await authClient.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
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
router.post('/email-code/verify', async (req, res) => {
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
