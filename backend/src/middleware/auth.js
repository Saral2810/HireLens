// Polyfill global WebSocket for environments where native WebSocket is absent (e.g. Node < 22)
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class DummyWebSocket {
    constructor() {}
    close() {}
    send() {}
    addEventListener() {}
    removeEventListener() {}
  };
}

import db from '../config/db.js';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Credentials come ONLY from .env — no hardcoded fallbacks.
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
const supabase = db.supabase || (supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null);

// Comma-separated list of emails that get Super Admin rights. Set in .env.
const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.replace(/^[\"' ]+|[\"' ]+$/g, '').trim().toLowerCase()).filter(Boolean);

// Placeholder identity used ONLY in offline mock mode / tests.
const MOCK_SUPERADMIN = { id: 'mock-uuid-superadmin', email: 'superadmin@local.dev', isSuperAdmin: true };

// Mock "Bearer mock-..." tokens are a dev convenience. They are refused when a real
// Supabase database is connected, unless you explicitly set ALLOW_MOCK_AUTH=true.
const MOCK_AUTH_ALLOWED = () => db.isMock || process.env.NODE_ENV === 'test' || process.env.ALLOW_MOCK_AUTH === 'true';

/**
 * Extracts and verifies the Bearer token, attaching req.user
 */
export async function requireAuth(req, res, next) {
  try {
    let authHeader = req.headers.authorization || (req.query.token ? `Bearer ${req.query.token}` : undefined);
    
    // Normalize mock tokens (handles "Bearer mock-superadmin", "Bearer superadmin", "Bearer mock-tenant_demo", etc.)
    if (MOCK_AUTH_ALLOWED() && authHeader && (authHeader.startsWith('Bearer mock-') || authHeader.startsWith('Bearer mock_') || authHeader.startsWith('Bearer superadmin') || authHeader.startsWith('Bearer tenant_'))) {
      let tokenVal = authHeader.replace(/^Bearer\s+/i, '').replace(/^(mock[-_])+/i, '').trim();

      if (tokenVal === 'superadmin') {
        req.user = { ...MOCK_SUPERADMIN };
      } else if (tokenVal.startsWith('tenant_')) {
        const tId = tokenVal.replace('tenant_', '');
        let tenantUser = null;
        if (db.supabase && !db.isMock) {
          try {
            const { data } = await db.supabase
              .from('tenant_users')
              .select('*')
              .eq('tenant_id', tId)
              .maybeSingle();
            if (data) tenantUser = data;
          } catch (e) {}
        }
        if (!tenantUser) {
          tenantUser = (db.mockDb?.tenantUsers || []).find(u => u.tenant_id === tId);
        }
        req.user = {
          id: tenantUser?.user_id || tenantUser?.id || ('usr_' + tId + '_01'),
          email: tenantUser?.email || ('client@' + tId + '.local'),
          isSuperAdmin: false,
          mockRole: tenantUser?.role || 'admin',
          mockTenant: tId
        };
      } else if (tokenVal.includes(':')) {
        const parts = tokenVal.split(':');
        const knownRoles = ['owner', 'admin', 'member'];
        let role = 'member';
        let tId = '';
        let uId = 'mock-uuid-user';

        if (knownRoles.includes(parts[0].toLowerCase())) {
          role = parts[0].toLowerCase();
          tId = parts[1];
          uId = parts[2] || 'mock-uuid-user';
        } else if (knownRoles.includes(parts[1]?.toLowerCase())) {
          tId = parts[0];
          role = parts[1].toLowerCase();
          uId = parts[2] || 'mock-uuid-user';
        } else {
          tId = parts[0];
          role = parts[1] || 'member';
          uId = parts[2] || 'mock-uuid-user';
        }

        const mockU = (db.mockDb?.tenantUsers || []).find(u => u.id === uId || u.user_id === uId || u.email === uId);
        req.user = {
          id: uId,
          email: mockU?.email || `${role}@${tId}.com`,
          isSuperAdmin: false,
          mockRole: role,
          mockTenant: tId
        };
      } else {
        const mockU = (db.mockDb?.tenantUsers || []).find(u => u.id === tokenVal || u.user_id === tokenVal || u.email === tokenVal);
        if (mockU) {
          req.user = {
            id: mockU.id || mockU.user_id,
            email: mockU.email,
            isSuperAdmin: false,
            mockRole: mockU.role || 'member',
            mockTenant: mockU.tenant_id
          };
        } else {
          req.user = { ...MOCK_SUPERADMIN };
        }
      }
      return next();
    }

    if (process.env.NODE_ENV === 'test' && (!authHeader || authHeader === 'Bearer test')) {
      req.user = { ...MOCK_SUPERADMIN };
      return next();
    }
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      const targetTenant = req.query.tenant_id || req.body?.tenant_id || req.headers['x-tenant-id'];
      if (targetTenant && db.isMock) {
        req.user = { ...MOCK_SUPERADMIN };
        req.tenant_id = targetTenant;
        req.tenant_role = 'admin';
        return next();
      }
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing or invalid Authorization header.' });
    }

    const token = authHeader.split(' ')[1];
    const activeClient = db.supabase || supabase;
    if (!activeClient) {
      if (MOCK_AUTH_ALLOWED()) {
        req.user = { ...MOCK_SUPERADMIN };
        return next();
      }
      return res.status(503).json({ error: 'Auth not configured', message: 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.' });
    }
    const { data: { user }, error } = await activeClient.auth.getUser(token);

    if (error || !user) {
      if (MOCK_AUTH_ALLOWED()) {
        req.user = { ...MOCK_SUPERADMIN };
        return next();
      }
      return res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired token.' });
    }

    req.user = user;
    const userEmail = (user.email || '').toLowerCase();
    req.user.isSuperAdmin = SUPER_ADMIN_EMAILS.includes(userEmail);
    next();
  } catch (err) {
    console.error('[Auth Middleware] Error in requireAuth:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

/**
 * Ensures the authenticated user is a Super Admin
 */
export async function requireSuperAdmin(req, res, next) {
  if (!req.user || !req.user.isSuperAdmin) {
    return res.status(403).json({ error: 'Forbidden', message: 'Super Admin access required.' });
  }
  next();
}

/**
 * Ensures the user has access to the requested tenant_id
 */
export async function requireTenantAccess(req, res, next) {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let targetTenantId = req.query.tenant_id || req.body?.tenant_id || req.params?.tenant_id || req.headers['x-tenant-id'];
    if (!targetTenantId && (req.originalUrl?.includes('/draft/') || req.path?.includes('/draft/'))) {
      const match = (req.originalUrl || req.path).match(/\/draft\/([^/?#]+)/);
      if (match && match[1]) {
        targetTenantId = decodeURIComponent(match[1]);
      }
    }
    if (!targetTenantId && req.params?.id) {
      try {
        const lead = await db.findLeadById(req.params.id);
        if (lead) targetTenantId = lead.tenant_id;
      } catch(e) {}

      if (!targetTenantId) {
        try {
          if (supabase) {
            const { data: camp } = await supabase.from('campaigns').select('tenant_id').eq('id', req.params.id).maybeSingle();
            if (camp) targetTenantId = camp.tenant_id;
          } else if (db.mockDb?.campaigns) {
            const camp = db.mockDb.campaigns.find(c => c.id === req.params.id);
            if (camp) targetTenantId = camp.tenant_id;
          }
        } catch(e) {}
      }
    }

    // Auto-fallback if targetTenantId is omitted for a single-tenant user
    if (!targetTenantId) {
      if (req.user.mockTenant) {
        targetTenantId = req.user.mockTenant;
      } else if (!db.isMock && supabase) {
        const { data: userTenants } = await supabase
          .from('tenant_users')
          .select('tenant_id')
          .eq('user_id', req.user.id);
        if (userTenants && userTenants.length === 1) {
          targetTenantId = userTenants[0].tenant_id;
        }
      }
    }

    if (!targetTenantId) {
      return res.status(400).json({ error: 'Bad Request', message: 'tenant_id is required.' });
    }

    // Super admins have access to everything
    if (req.user.isSuperAdmin) {
      req.tenant_id = targetTenantId;
      req.tenant_role = 'owner'; // super admins act as owner
      return next();
    }

    if (db.isMock || process.env.NODE_ENV === 'test' || (req.user.mockTenant && req.user.mockRole)) {
      if (req.user.mockRole) {
        if (req.user.mockTenant && req.user.mockTenant !== targetTenantId) {
          return res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this tenant.' });
        }
        req.tenant_id = targetTenantId;
        req.tenant_role = req.user.mockRole;
      } else {
        const mockUser = db.mockDb?.tenantUsers?.find(tu => tu.user_id === req.user.id && tu.tenant_id === targetTenantId);
        if (mockUser) {
          req.tenant_id = targetTenantId;
          req.tenant_role = mockUser.role || 'member';
        } else {
          req.tenant_id = targetTenantId;
          req.tenant_role = 'admin';
        }
      }
    } else {
      // Check mapping in DB
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.user.id);
      let query = supabase
        .from('tenant_users')
        .select('tenant_id, role')
        .eq('tenant_id', targetTenantId);
      
      if (isUuid) {
        query = query.eq('user_id', req.user.id);
      } else if (req.user.email) {
        query = query.eq('email', req.user.email);
      } else {
        query = query.eq('user_id', req.user.id);
      }

      const { data, error } = await query.maybeSingle();

      if (error || !data) {
        return res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this tenant.' });
      }
      
      // Securely attach the validated tenant_id and role to the request object
      req.tenant_id = data.tenant_id;
      req.tenant_role = data.role || 'member';
    }

    // Validate agent scoping if agent_name is present and already suffixed
    const agentName = req.body.agent_name || req.query.agent_name || req.params.agent_name;
    if (agentName && agentName.includes('_TAG')) {
      const tenant = await db.getTenantConfigById(req.tenant_id);
      const { validateAgentBelongsToTenant } = await import('../lib/tenantIdentity.js');
      if (tenant && tenant.tenant_tag) {
        if (!validateAgentBelongsToTenant(agentName, tenant.tenant_tag)) {
           return res.status(403).json({ error: 'Forbidden', message: 'Agent does not belong to this tenant scope.' });
        }
      }
    }

    next();
  } catch (err) {
    console.error('[Auth Middleware] Error in requireTenantAccess:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

// Retain API Key fallback if needed by external integrators (CRMs, partner systems, etc.)
export async function authenticateApiKey(req, res, next) {
  try {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey) {
      return res.status(401).json({ error: 'Unauthorized', message: 'Missing x-api-key header.' });
    }
    const tenantId = await db.getTenantByApiKey(apiKey);
    if (!tenantId) {
      return res.status(403).json({ error: 'Forbidden', message: 'Invalid API Key.' });
    }
    req.tenant_id = tenantId;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Internal Server Error' });
  }
}

import { hasPermission } from '../lib/permissions.js';

export function requireTenantRole(permission) {
  return (req, res, next) => {
    // Super admins can bypass role checks
    if (req.user && req.user.isSuperAdmin) {
      return next();
    }

    const userRole = req.tenant_role;
    if (!userRole) {
       return res.status(403).json({ error: 'Forbidden', message: 'No tenant role identified.' });
    }

    if (!hasPermission(userRole, permission)) {
       return res.status(403).json({ error: 'Forbidden', message: `Missing required permission: ${permission}` });
    }

    next();
  };
}
