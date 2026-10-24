import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import leadsRouter from './routes/leads.js';
import campaignsRouter from './routes/campaigns.js';
import schedulerRouter from './routes/scheduler.js';
import apiRouter from './routes/api.js';
import voiceProviderAdminRouter from './routes/voiceProviderAdmin.js';
import agentsRouter from './routes/agents.js';
import integrationsRouter from './routes/integrations.js';
import tenantsRouter from './routes/tenants.js';
import { requireAuth, requireTenantAccess, requireSuperAdmin } from './middleware/auth.js';
import db, { createAuthClient } from './config/db.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
// Skip global JSON parsing for provider webhooks (/leads/webhook/<provider>) so the route can read
// the raw bytes and verify the provider's HMAC signature.
app.use((req, res, next) => {
  if (req.originalUrl.startsWith('/leads/webhook/')) {
    next();
  } else {
    express.json({
      limit: '50mb',
      verify: (req, res, buf) => {
        req.rawBody = buf.toString('utf8');
      }
    })(req, res, next);
  }
});

// Log incoming requests
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Serve the built React client (run `npm run build` first). In dev, use `npm run client:dev` instead.
const frontendPath = path.join(__dirname, '../../client/dist');
if (fs.existsSync(frontendPath)) {
  app.use(express.static(frontendPath));
} else {
  console.log('[App] client/dist not found — run `npm run build` to serve the UI from this server.');
}

// Apply Auth to Tenant management
app.use('/tenants', tenantsRouter); // tenantsRouter itself has requireAuth/SuperAdmin

// Middleware wrapper for standard dashboard routes
const applyDashboardAuth = (req, res, next) => {
  const isBypass =
    req.originalUrl.startsWith('/leads/recordings/') ||
    req.originalUrl.startsWith('/recordings/') ||
    req.originalUrl.startsWith('/leads/webhook/') ||
    req.originalUrl.startsWith('/leads/webhooks/') ||
    req.originalUrl.startsWith('/webhooks/') ||
    req.originalUrl.startsWith('/webhook/') ||
    req.originalUrl.includes('/callback') ||
    req.originalUrl.includes('/public');

  if (isBypass) {
    return next();
  }

  // Debug endpoints are cross-tenant superadmin diagnostics — they enforce their own
  // requireSuperAdmin gate inside the route handler. Skip requireTenantAccess (which
  // demands a tenant_id in query/body/params and would 400 these routes) but keep
  // requireAuth so req.user is populated for the superadmin check downstream.
  const isSuperAdminDebug =
    req.originalUrl.startsWith('/leads/debug/') ||
    req.originalUrl.startsWith('/campaigns/debug/') ||
    req.originalUrl.startsWith('/scheduler/debug/') ||
    req.originalUrl.startsWith('/integrations/debug/');
  if (isSuperAdminDebug) {
    return requireAuth(req, res, next);
  }

  requireAuth(req, res, () => {
    requireTenantAccess(req, res, next);
  });
};

// Top-level aliases for audio recording playback so /recordings/:session_id works directly
app.get(['/recordings/:session_id/audio', '/recordings/:session_id'], (req, res, next) => {
  req.url = `/recordings/${req.params.session_id}/audio`;
  return leadsRouter(req, res, next);
});

app.use('/leads', applyDashboardAuth, leadsRouter);
app.use('/campaigns', applyDashboardAuth, campaignsRouter);
app.use('/scheduler', applyDashboardAuth, schedulerRouter);
app.use('/integrations', applyDashboardAuth, integrationsRouter);
app.use('/admin/agents', applyDashboardAuth, agentsRouter);
app.use('/api/v1', apiRouter); // Externally facing API, typically uses authenticateApiKey
app.use('/admin/voice-providers', applyDashboardAuth, voiceProviderAdminRouter);

// PATCH /admin/campaigns/:id/switch-provider
app.patch('/admin/campaigns/:id/switch-provider', applyDashboardAuth, async (req, res, next) => {
  try {
    const campaignId = req.params.id;
    const { new_provider_type, new_voice_agent_id } = req.body;
    const drain = req.query.drain === 'true';

    if (!new_provider_type || !new_voice_agent_id) {
      return res.status(400).json({ error: 'new_provider_type and new_voice_agent_id are required.' });
    }

    const db = (await import('./config/db.js')).default;
    
    // Resolve campaign first
    let campaign = null;
    if (db.supabase) {
      const { data: camp, error: campErr } = await db.supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .maybeSingle();
      if (campErr) throw campErr;
      campaign = camp;
    } else {
      campaign = (db.mockDb?.campaigns || []).find(c => c.id === campaignId) || null;
    }

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    const tenant_id = req.tenant_id || req.body?.tenant_id || req.query?.tenant_id || campaign.tenant_id;

    if (req.tenant_id && req.tenant_id !== campaign.tenant_id && !req.user?.isSuperAdmin) {
      return res.status(403).json({ error: 'Forbidden', message: 'You do not have access to this campaign.' });
    }

    if (db.supabase) {
      // 1. Verify provider is configured and not disabled
      const { data: prov, error: provErr } = await db.supabase
        .from('tenant_voice_providers')
        .select('provider_type')
        .eq('tenant_id', tenant_id)
        .eq('provider_type', new_provider_type)
        .is('disabled_at', null)
        .maybeSingle();

      if (provErr) throw provErr;
      if (!prov) return res.status(400).json({ error: 'Provider is not configured or is disabled.' });

      // 2. Verify agent exists
      try {
        const { getProvider } = await import('./services/voiceProvider/index.js');
        const providerInstance = await getProvider(tenant_id, new_provider_type);
        const agents = await providerInstance.getAgents();
        
        if (agents && agents.length > 0 && !agents.some(a => a.id === new_voice_agent_id || a.agent_id === new_voice_agent_id || a.voice_id === new_voice_agent_id)) {
          return res.status(400).json({ error: 'Agent ID does not exist in the new provider.' });
        }
      } catch (agentErr) {
        console.warn(`[switch-provider] Live agent check notice: ${agentErr.message}`);
      }

      // 3. Check for queued / in-flight calls
      const { count: qCount } = await db.supabase.from('call_queue').select('*', { count: 'exact', head: true }).eq('campaign_id', campaignId);
      const { count: iCount } = await db.supabase.from('call_sessions').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id).is('ended_at', null).eq('campaign_id', campaignId);
      
      if ((qCount > 0 || iCount > 0) && !drain) {
        return res.status(409).json({ error: 'Campaign has queued or in-flight calls. Must drain first.', queued_calls: qCount || 0, in_flight_sessions: iCount || 0 });
      }

      if (drain) {
        // Cancel queued
        await db.supabase.from('call_queue').update({ status: 'canceled', last_dial_error: 'provider_switched' }).eq('campaign_id', campaignId);
      }

      // 4. Update campaign
      const { data: updated, error: updErr } = await db.supabase
        .from('campaigns')
        .update({ voice_provider: new_provider_type, voice_agent_id: new_voice_agent_id })
        .eq('id', campaignId)
        .eq('tenant_id', tenant_id)
        .select()
        .maybeSingle();

      if (updErr) throw updErr;

      res.json({ success: true, campaign: updated });
    } else {
      // Mock DB mode
      campaign.voice_provider = new_provider_type;
      campaign.voice_agent_id = new_voice_agent_id;
      res.json({ success: true, campaign });
    }
  } catch (error) {
    next(error);
  }
});


import dispatcher from './workers/dispatcher.js';
app.get('/api/trigger-dispatcher', requireAuth, requireSuperAdmin, async (req, res) => {
  try {
    await dispatcher.tick();
    res.json({ success: true, message: 'Dispatcher tick executed manually.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

const getSuperAdminEmails = () => (process.env.SUPER_ADMIN_EMAILS || '')
  .split(',')
  .map(e => e.replace(/^["' ]+|["' ]+$/g, '').trim().toLowerCase())
  .filter(Boolean);

/**
 * POST /api/auth/login
 * - Real mode (Supabase connected): checks the email/password with Supabase Auth. Nothing else.
 * - Mock mode (no Supabase): lets you log in locally as
 *     superadmin  -> any email in SUPER_ADMIN_EMAILS (or superadmin@local.dev) + MOCK_ADMIN_PASSWORD
 *     tenant user -> a user from the in-memory mock DB + its temp_password
 */
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const lowerEmail = email.trim().toLowerCase();
    const superAdminEmails = getSuperAdminEmails();
    const isSuperAdminEmail = superAdminEmails.includes(lowerEmail);

    // 1. Real Supabase authentication
    if (db.supabase && !db.isMock) {
      // Separate client: signing in on db.supabase would make all later queries run as this user.
      const authAttempt = await createAuthClient().auth.signInWithPassword({ email: lowerEmail, password });
      if (authAttempt.error || !authAttempt.data?.session) {
        return res.status(401).json({ error: 'Invalid credentials. No account matches this email and password.' });
      }

      let allowedTenants = [];
      if (isSuperAdminEmail) {
        const allTenants = await db.getAllTenantConfigs();
        allowedTenants = allTenants.map(t => t.tenant_id);
      } else {
        const { data: userTenants } = await db.supabase
          .from('tenant_users')
          .select('tenant_id')
          .eq('user_id', authAttempt.data.user.id);
        allowedTenants = (userTenants || []).map(t => t.tenant_id);
      }

      return res.json({
        success: true,
        token: authAttempt.data.session.access_token,
        user: {
          id: authAttempt.data.user.id,
          email: authAttempt.data.user.email,
          isSuperAdmin: isSuperAdminEmail,
          allowedTenants,
          role: isSuperAdminEmail ? 'superadmin' : 'admin'
        }
      });
    }

    // 2. Offline mock mode (local development only)
    const mockAdminPassword = process.env.MOCK_ADMIN_PASSWORD || 'ChangeMe@123';
    if ((isSuperAdminEmail || lowerEmail === 'superadmin@local.dev') && password === mockAdminPassword) {
      const allTenants = await db.getAllTenantConfigs();
      return res.json({
        success: true,
        token: 'superadmin',
        user: {
          id: 'mock-uuid-superadmin',
          email: lowerEmail,
          isSuperAdmin: true,
          allowedTenants: allTenants.map(t => t.tenant_id),
          role: 'superadmin'
        }
      });
    }

    const matchedUser = (db.mockDb?.tenantUsers || []).find(u => (u.email || '').toLowerCase() === lowerEmail);
    if (matchedUser && matchedUser.temp_password && matchedUser.temp_password === password) {
      return res.json({
        success: true,
        token: 'tenant_' + matchedUser.tenant_id,
        user: {
          id: matchedUser.user_id || matchedUser.id,
          email: matchedUser.email,
          isSuperAdmin: false,
          allowedTenants: [matchedUser.tenant_id],
          role: matchedUser.role || 'admin',
          tenant_id: matchedUser.tenant_id
        }
      });
    }

    return res.status(401).json({ error: 'Invalid credentials. No account matches this email and password.' });
  } catch (err) {
    console.error('[POST /api/auth/login] Error:', err);
    res.status(500).json({ error: 'Authentication service error.' });
  }
});

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const isSuperAdminUser = req.user.isSuperAdmin || getSuperAdminEmails().includes((req.user.email || '').toLowerCase());
    if (isSuperAdminUser) {
      const allTenants = await db.getAllTenantConfigs();
      const allTenantIds = allTenants.map(t => t.tenant_id);
      const rolesMap = {};
      allTenantIds.forEach(tId => {
        rolesMap[tId] = 'owner';
      });
      return res.json({
        id: req.user.id,
        email: req.user.email,
        isSuperAdmin: true,
        allowedTenants: allTenantIds,
        roles: rolesMap
      });
    }

    // Guard against null Supabase in mock/local mode
    if (db.isMock || !db.supabase) {
      const mockAllowed = req.user.mockTenant
        ? [req.user.mockTenant]
        : (db.mockDb?.tenantUsers?.filter(tu => tu.user_id === req.user.id).map(tu => tu.tenant_id) || []);
      const mockRoles = {};
      (db.mockDb?.tenantUsers || []).filter(tu => tu.user_id === req.user.id).forEach(tu => {
        mockRoles[tu.tenant_id] = tu.role;
      });
      if (req.user.mockTenant && req.user.mockRole) {
        mockRoles[req.user.mockTenant] = req.user.mockRole;
      }
      return res.json({
        id: req.user.id,
        email: req.user.email,
        isSuperAdmin: false,
        allowedTenants: mockAllowed,
        roles: mockRoles
      });
    }

    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(req.user.id);
    let query = db.supabase
      .from('tenant_users')
      .select('tenant_id, role, tenant_configs!inner(status)')
      .neq('tenant_configs.status', 'deleted');
    
    if (isUuid) {
      query = query.eq('user_id', req.user.id);
    } else if (req.user.email) {
      query = query.eq('email', req.user.email);
    }

    const { data: tenantUsers, error } = await query;
    
    const rolesMap = {};
    if (!error && tenantUsers) {
      tenantUsers.forEach(tu => {
        rolesMap[tu.tenant_id] = tu.role;
      });
    }

    if (req.user.mockTenant && req.user.mockRole) {
      rolesMap[req.user.mockTenant] = req.user.mockRole;
    }

    const allowed = Object.keys(rolesMap);

    res.json({
      id: req.user.id,
      email: req.user.email,
      isSuperAdmin: false,
      allowedTenants: allowed,
      roles: rolesMap
    });
  } catch (err) {
    console.error('[GET /api/auth/me] Error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Health check routes for AWS ALB, ECS Target Groups, App Runner, and Kubernetes
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    environment: process.env.NODE_ENV || 'production',
    database: db.isMock ? 'mock_mode' : (db.supabase ? 'connected' : 'disconnected')
  });
});

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'live' });
});

app.get('/health/ready', (req, res) => {
  res.status(200).json({ status: 'ready' });
});

// Fallback to index.html for single page app routing (if needed)
app.get('*', (req, res, next) => {
  // Exclude all API/backend route prefixes from SPA fallback so they return a proper 404
  const apiPrefixes = ['/leads', '/campaigns', '/scheduler', '/integrations', '/tenants', '/api', '/admin', '/health', '/recordings'];
  if (apiPrefixes.some(prefix => req.url.startsWith(prefix))) {
    return next();
  }
  const indexFile = path.join(frontendPath, 'index.html');
  if (!fs.existsSync(indexFile)) {
    return res.status(404).send('UI not built. Run `npm run build`, or use `npm run client:dev` for development.');
  }
  res.sendFile(indexFile);
});

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Error:', err);

  if (err.code === '23505') {
    return res.status(409).json({
      error: 'Conflict',
      message: 'A lead with this phone number already exists under the specified tenant.'
    });
  }

  const status = err.status || 500;
  res.status(status).json({
    error: err.name || 'Internal Server Error',
    message: err.message || 'An unexpected error occurred.'
  });
});

export default app;
