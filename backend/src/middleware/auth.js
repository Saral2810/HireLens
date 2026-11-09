import db from '../config/db.js';

// Roles, within a workspace (see database/migrations/20261109_workspaces.sql):
//   superadmin  shown as "Admin": every campaign in their workspace, manages its team
//   hr_lead     shown as "HR lead": leads a sign-up workspace; every campaign in it, adds Recruiters only
//   recruiter   only the campaigns they created
// Admin, HR lead and Recruiter together are the HR team. Nobody reaches another workspace.
export const ROLES = Object.freeze({ SUPERADMIN: 'superadmin', HR_LEAD: 'hr_lead', RECRUITER: 'recruiter', CANDIDATE: 'candidate' });
export const HR_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.HR_LEAD, ROLES.RECRUITER]);
export const MANAGER_ROLES = Object.freeze([ROLES.SUPERADMIN, ROLES.HR_LEAD]);
export const isHr = (role) => HR_ROLES.includes(role);
/** Admin or HR lead: reaches every campaign in their own workspace and manages its team. */
export const isManager = (role) => MANAGER_ROLES.includes(role);

/** The workspace the existing team works in (created by the workspaces migration). */
export const MAIN_WORKSPACE_ID = '00000000-0000-0000-0000-000000000001';

// Roles and workspaces come from the profiles table (one row per auth user, see database/README.md).
// Cached briefly so every request does not hit the database.
const ROLE_CACHE_MS = 30 * 1000;
const roleCache = new Map();

/**
 * Role and workspace of a signed-in user. Users without an HR profile are treated as candidates,
 * who have no workspace.
 * @param {string} userId
 * @returns {Promise<{ role: 'superadmin'|'hr_lead'|'recruiter'|'candidate', workspaceId: string|null }>}
 */
export async function getAccess(userId) {
  const cached = roleCache.get(userId);
  if (cached && cached.expires > Date.now()) return cached.access;
  const profile = await db.getProfile(userId);
  const hr = HR_ROLES.includes(profile?.role) && !!profile?.workspace_id;
  const access = { role: hr ? profile.role : ROLES.CANDIDATE, workspaceId: hr ? profile.workspace_id : null };
  roleCache.set(userId, { access, expires: Date.now() + ROLE_CACHE_MS });
  return access;
}

/** Role of a signed-in user (see getAccess). */
export async function getRole(userId) {
  return (await getAccess(userId)).role;
}

/** Forget a cached role (after the Team page or a sign-up changes it). */
export function clearRoleCache(userId) {
  roleCache.delete(userId);
}

// Tests run without Supabase. They authenticate with "Bearer test:<role>:<userId>[:<email>[:<workspaceId>]]".
// HR test users are in the main workspace unless a workspace is given.
function parseTestToken(token) {
  if (process.env.NODE_ENV !== 'test' || !token.startsWith('test:')) return null;
  const [, role, id = 'test-user', email = `${id}@test.local`, workspace] = token.split(':');
  if (!Object.values(ROLES).includes(role)) return null;
  return { id, email, role, workspace_id: isHr(role) ? (workspace || MAIN_WORKSPACE_ID) : null };
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

    const access = await getAccess(data.user.id);
    req.user = { id: data.user.id, email: data.user.email, role: access.role, workspace_id: access.workspaceId };
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
