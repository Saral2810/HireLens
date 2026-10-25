import db from '../config/db.js';

// superadmin is shown as "Admin" in the app. Admin and Recruiter together are the HR team.
export const ROLES = Object.freeze({ SUPERADMIN: 'superadmin', RECRUITER: 'recruiter', CANDIDATE: 'candidate' });
export const HR_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.RECRUITER]);
export const isHr = (role) => HR_ROLES.includes(role);

// Roles come from the profiles table (one row per auth user, see database/README.md).
// Cached briefly so every request does not hit the database.
const ROLE_CACHE_MS = 30 * 1000;
const roleCache = new Map();

/**
 * Role of a signed-in user. Users without a profile row are treated as candidates.
 * @param {string} userId
 * @returns {Promise<'superadmin'|'recruiter'|'candidate'>}
 */
export async function getRole(userId) {
  const cached = roleCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.role;
  const profile = await db.getProfile(userId);
  const role = HR_ROLES.includes(profile?.role) ? profile.role : ROLES.CANDIDATE;
  roleCache.set(userId, { role, expires: Date.now() + ROLE_CACHE_MS });
  return role;
}

/** Forget a cached role (after the Team page changes it). */
export function clearRoleCache(userId) {
  roleCache.delete(userId);
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

    req.user = { id: data.user.id, email: data.user.email, role: await getRole(data.user.id) };
    next();
  } catch (err) {
    console.error('[Auth Middleware] Error in requireAuth:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * Allows the request only for the given roles. Use after requireAuth.
 * @param {...('superadmin'|'recruiter'|'candidate')} roles
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this area.' });
    }
    next();
  };
}
