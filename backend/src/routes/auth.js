import { Router } from 'express';
import db, { createAuthClient } from '../config/db.js';
import { requireAuth, getRole, ROLES } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/login  (HR)
 * Checks the email/password with Supabase Auth and returns the session token and role.
 * Candidates do not have passwords; they sign in through an invite link.
 */
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const authClient = createAuthClient();
    if (!authClient) {
      return res.status(503).json({ error: 'Auth not configured', message: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.' });
    }

    // Separate client: signing in on db.supabase would make all later queries run as this user.
    const authAttempt = await authClient.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (authAttempt.error || !authAttempt.data?.session) {
      return res.status(401).json({ error: 'Invalid credentials. No account matches this email and password.' });
    }

    const { user, session } = authAttempt.data;
    res.json({
      success: true,
      token: session.access_token,
      user: { id: user.id, email: user.email, role: await getRole(user.id) }
    });
  } catch (err) {
    console.error('[POST /api/auth/login] Error:', err);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

/**
 * GET /api/auth/me
 * The signed-in user. Candidates also get their candidate record and batch.
 */
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const me = { id: req.user.id, email: req.user.email, role: req.user.role, name: null };
    if (!db.isConfigured) return res.json(me);

    if (req.user.role === ROLES.CANDIDATE) {
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
