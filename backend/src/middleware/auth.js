import db from '../config/db.js';

export const ROLES = Object.freeze({ SUPERADMIN: 'superadmin', CANDIDATE: 'candidate' });

/** Emails in SUPER_ADMIN_EMAILS (comma-separated) get the superadmin role. */
export function getSuperAdminEmails() {
  return (process.env.SUPER_ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.replace(/^["' ]+|["' ]+$/g, '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Role for a signed-in user. Until the profiles table exists (roadmap Phase C) the role comes
 * from SUPER_ADMIN_EMAILS; everyone else is a candidate.
 * @param {{ email?: string }} user
 * @returns {'superadmin'|'candidate'}
 */
export function resolveRole(user) {
  return getSuperAdminEmails().includes((user?.email || '').toLowerCase()) ? ROLES.SUPERADMIN : ROLES.CANDIDATE;
}

// Tests run without Supabase. They authenticate with "Bearer test:<role>:<userId>[:<email>]".
function parseTestToken(token) {
  if (process.env.NODE_ENV !== 'test' || !token.startsWith('test:')) return null;
  const [, role, id = 'test-user', email = `${id}@test.local`] = token.split(':');
  if (!Object.values(ROLES).includes(role)) return null;
  return { id, email, role };
}

/**
 * Verifies the Bearer token with Supabase Auth and attaches req.user = { id, email, role }.
 */
export async function requireAuth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    if (!header.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header.' });
    }
    const token = header.slice('Bearer '.length).trim();

    const testUser = parseTestToken(token);
    if (testUser) {
      req.user = testUser;
      return next();
    }

    if (!db.supabase) {
      return res.status(503).json({ error: 'Auth not configured', message: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.' });
    }

    const { data, error } = await db.supabase.auth.getUser(token);
    if (error || !data?.user) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token.' });
    }

    req.user = { id: data.user.id, email: data.user.email, role: resolveRole(data.user) };
    next();
  } catch (err) {
    console.error('[Auth Middleware] Error in requireAuth:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * Allows the request only for the given roles. Use after requireAuth.
 * @param {...('superadmin'|'candidate')} roles
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this area.' });
    }
    next();
  };
}
