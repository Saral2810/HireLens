import express from 'express';
import { tenantConfigService } from '../services/tenantConfigService.js';
import { requireAuth, requireTenantAccess, requireTenantRole, requireSuperAdmin } from '../middleware/auth.js';
import db from '../config/db.js';

const router = express.Router();

// Apply auth to all tenant routes globally
router.use(requireAuth);

// ─────────────────────────────────────────────
// TENANT CRUD
// ─────────────────────────────────────────────

// GET all tenants for the authenticated user
router.get('/', async (req, res) => {
  try {
    const tenants = await tenantConfigService.getTenantsForUser(req.user.id, req.user.isSuperAdmin);
    res.json(tenants);
  } catch (err) {
    console.error('[GET /tenants] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET single tenant — return 404 if not found (not a default fallback)
router.get('/:tenant_id', requireTenantAccess, async (req, res) => {
  try {
    const tenant = await db.getTenantConfigById(req.params.tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
    res.json(tenant);
  } catch (err) {
    console.error(`[GET /tenants/${req.params.tenant_id}] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// POST create tenant + admin user + initial API key
router.post('/', requireSuperAdmin, async (req, res) => {
  try {
    const { adminEmail, adminPassword, ...config } = req.body;
    if (!adminEmail || !adminPassword) {
      return res.status(400).json({ error: 'Admin Email and Password are required' });
    }
    if (adminPassword.length < 6) {
      return res.status(400).json({ error: 'Admin Password must be at least 6 characters' });
    }

    // 1. Create Tenant Config
    let newTenant;
    try {
      newTenant = await tenantConfigService.createTenant(config);
    } catch (configErr) {
      console.error('[POST /tenants] Failed to create tenant config:', configErr);
      return res.status(400).json({ error: 'Failed to create workspace: ' + configErr.message });
    }

    let warnings = [];

    // 2. Create User in Supabase Auth
    if (db.isMock) {
      try {
        await db.insertTenantUser(newTenant.tenant_id, 'mock-uuid-' + Date.now(), 'admin', adminEmail, adminPassword);
      } catch (e) {
        warnings.push('Mock user setup failed.');
      }
    } else {
      try {
        const { data: authData, error: authError } = await db.supabase.auth.admin.createUser({
          email: adminEmail,
          password: adminPassword,
          email_confirm: true,
          user_metadata: { name: config.name || config.tenant_id, tenant_id: config.tenant_id, initial_password: adminPassword }
        });

        if (authError) {
          console.error('[POST /tenants] Supabase auth.admin.createUser error:', authError);
          warnings.push(`Admin user provisioning failed: ${authError.message}. Use "Provision User" to add manually.`);
        } else {
          await db.insertTenantUser(newTenant.tenant_id, authData.user.id, 'admin', adminEmail, adminPassword);
        }
        // Optional: also register your super admin in tenant_users (for RLS) by setting
        // SUPERADMIN_USER_ID + the first SUPER_ADMIN_EMAILS entry in .env
        if (process.env.SUPERADMIN_USER_ID && process.env.SUPER_ADMIN_EMAILS) {
          const suEmail = process.env.SUPER_ADMIN_EMAILS.split(',')[0].trim().toLowerCase();
          await db.insertTenantUser(newTenant.tenant_id, process.env.SUPERADMIN_USER_ID, 'owner', suEmail, null).catch(() => {});
        }
      } catch (authEx) {
        console.error('[POST /tenants] Exception during user creation:', authEx);
        warnings.push(`Admin provisioning error: ${authEx.message}`);
      }
    }

    // 3. Auto-generate initial API key
    let apiKey = null;
    try {
      const keyData = await db.createApiKey(newTenant.tenant_id, 'Initial API Key');
      apiKey = keyData.api_key;
    } catch (keyErr) {
      console.error('[POST /tenants] Failed to create initial API key:', keyErr);
      warnings.push('Initial API key generation failed.');
    }

    const response = {
      ...newTenant,
      adminEmail,
      adminPassword,
      initialApiKey: apiKey
    };
    if (warnings.length > 0) {
      response.warning = warnings.join(' ');
    }
    return res.status(201).json(response);
  } catch (err) {
    console.error('[POST /tenants] Unhandled error:', err);
    res.status(400).json({ error: err.message });
  }
});

// PUT update tenant
router.put('/:tenant_id', requireTenantAccess, requireTenantRole('tenant:edit'), async (req, res) => {
  try {
    const updated = await tenantConfigService.updateTenant(req.params.tenant_id, req.body);
    res.json(updated);
  } catch (err) {
    console.error(`[PUT /tenants/${req.params.tenant_id}] Error:`, err);
    res.status(400).json({ error: err.message });
  }
});

// DELETE tenant (soft delete)
router.delete('/:tenant_id', requireTenantAccess, requireTenantRole('tenant:delete'), async (req, res) => {
  try {
    await tenantConfigService.deleteTenant(req.params.tenant_id);
    res.status(204).send();
  } catch (err) {
    console.error(`[DELETE /tenants/${req.params.tenant_id}] Error:`, err);
    res.status(400).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
function generateSharePackage(req, tenant, user) {
  const protocol = req.protocol || 'http';
  const host = req.get('host') || 'localhost:3000';
  const portalUrl = `${protocol}://${host}`;
  const tenantName = tenant?.name || tenant?.tenant_id || user.tenant_id;
  const password = user.temp_password || user.password || '(set by admin)';

  const message = [
    `👋 Welcome to ${process.env.APP_NAME || 'Gnani.ai'},`,
    ``,
    `Your client portal credentials for "${tenantName}" are ready:`,
    `🏢 Workspace: ${tenantName} (${user.tenant_id})`,
    `🌐 Login URL: ${portalUrl}`,
    `👤 Email: ${user.email}`,
    `🔑 Password: ${password}`,
    `🛡️ Role: ${user.role || 'admin'}`,
    ``,
    `Access your dashboard anytime to track live qualification and inbound/outbound calls.`
  ].join('\n');

  const whatsappUrl = `https://api.whatsapp.com/send?text=${encodeURIComponent(message)}`;
  const mailtoUrl = `mailto:${user.email}?subject=${encodeURIComponent(`${process.env.APP_NAME || 'Gnani.ai'} Login Credentials - ${tenantName}`)}&body=${encodeURIComponent(message)}`;

  return {
    portal_url: portalUrl,
    tenant_id: user.tenant_id,
    tenant_name: tenantName,
    email: user.email,
    password,
    role: user.role || 'admin',
    formatted_message: message,
    whatsapp_url: whatsappUrl,
    mailto_url: mailtoUrl
  };
}

// USER MANAGEMENT PER TENANT
// ─────────────────────────────────────────────

// GET /:tenant_id/users — list all users for a tenant
router.get('/:tenant_id/users', requireTenantAccess, requireTenantRole('users:read'), async (req, res) => {
  try {
    const tenantId = req.params.tenant_id;
    const tenant = await db.getTenantConfigById(tenantId);
    const SUPER_ADMIN_EMAILS = (process.env.SUPER_ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);

    if (db.isMock || !db.supabase) {
      const rawUsers = (db.mockDb?.tenantUsers || []).filter(tu => 
        tu.tenant_id === tenantId && 
        !SUPER_ADMIN_EMAILS.includes((tu.email || '').toLowerCase()) && 
        !SUPER_ADMIN_EMAILS.includes((tu.email || '').toLowerCase())
      );
      const users = rawUsers.map(tu => {
        const userObj = {
          id: tu.id,
          user_id: tu.user_id,
          tenant_id: tu.tenant_id,
          email: tu.email || 'client@company.com',
          role: tu.role || 'admin',
          temp_password: tu.temp_password || null,
          created_at: tu.created_at
        };
        return {
          ...userObj,
          share_package: generateSharePackage(req, tenant, userObj)
        };
      });
      return res.json({ users, tenant_name: tenant?.name || tenantId });
    }

    const { data, error } = await db.supabase
      .from('tenant_users')
      .select('id, user_id, role, email, temp_password, created_at')
      .eq('tenant_id', tenantId)
      .order('created_at', { ascending: false });
    if (error) throw error;

    // Enrich with email from Supabase Auth admin API if needed
    const enrichedUsers = (await Promise.all((data || []).map(async (u) => {
      let email = u.email;
      let tempPassword = u.temp_password;

      if (!email || !tempPassword) {
        try {
          const { data: userData } = await db.supabase.auth.admin.getUserById(u.user_id);
          if (!email && userData?.user?.email) email = userData.user.email;
          if (!tempPassword && userData?.user?.user_metadata?.initial_password) {
            tempPassword = userData.user.user_metadata.initial_password;
          }
        } catch (e) {
          // Silent catch
        }
      }

      email = email || 'client@company.com';
      tempPassword = tempPassword || null;

      // Strictly exclude any super admin accounts from tenant user list
      if (SUPER_ADMIN_EMAILS.includes(email.toLowerCase())) {
        return null;
      }

      const userObj = {
        id: u.id,
        user_id: u.user_id,
        tenant_id: tenantId,
        email,
        role: u.role || 'admin',
        temp_password: tempPassword,
        created_at: u.created_at
      };

      return {
        ...userObj,
        share_package: generateSharePackage(req, tenant, userObj)
      };
    }))).filter(Boolean);

    res.json({ users: enrichedUsers, tenant_name: tenant?.name || tenantId });
  } catch (err) {
    console.error(`[GET /tenants/${req.params.tenant_id}/users] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:tenant_id/users — provision a new admin user for a tenant
router.post('/:tenant_id/users', requireTenantAccess, requireTenantRole('users:invite'), async (req, res) => {
  try {
    const { email, password, role } = req.body;
    const tenantId = req.params.tenant_id;
    if (!email) return res.status(400).json({ error: 'Email is required' });

    const finalRole = role || 'admin';
    if (!['owner', 'admin', 'member'].includes(finalRole)) {
      return res.status(400).json({ error: 'Invalid role provided' });
    }

    const finalPassword = password || ('Tmp@' + Math.random().toString(36).slice(-8) + '!');

    // Verify tenant exists
    const tenant = await db.getTenantConfigById(tenantId);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    let userId = 'usr_' + Date.now();

    if (db.isMock || !db.supabase) {
      await db.insertTenantUser(tenantId, userId, finalRole, email, finalPassword);
    } else {
      const { data: authData, error: authError } = await db.supabase.auth.admin.createUser({
        email,
        password: finalPassword,
        email_confirm: true,
        user_metadata: { tenant_id: tenantId, initial_password: finalPassword }
      });

      if (authError) {
        if (authError.message.includes('already registered')) {
          return res.status(409).json({ error: 'User already exists in the system.' });
        }
        return res.status(400).json({ error: authError.message });
      }
      userId = authData.user.id;
      await db.insertTenantUser(tenantId, userId, finalRole, email, finalPassword);
    }

    const userObj = {
      tenant_id: tenantId,
      user_id: userId,
      email,
      role: finalRole,
      temp_password: finalPassword
    };

    const sharePackage = generateSharePackage(req, tenant, userObj);

    res.status(201).json({
      message: 'User provisioned successfully',
      email,
      password: finalPassword,
      role: finalRole,
      user_id: userId,
      share_package: sharePackage
    });
  } catch (err) {
    console.error(`[POST /tenants/${req.params.tenant_id}/users] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:tenant_id/users/:user_id/reset-password — re-issue password & generate fresh credentials
router.post('/:tenant_id/users/:user_id/reset-password', requireTenantAccess, requireTenantRole('users:invite'), async (req, res) => {
  try {
    const { tenant_id, user_id } = req.params;
    const { new_password } = req.body;
    const tenant = await db.getTenantConfigById(tenant_id);
    if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

    const finalPassword = new_password || ('Tmp@' + Math.random().toString(36).slice(-8) + '!');
    let targetEmail = 'client@company.com';
    let targetRole = 'admin';

    if (db.isMock || !db.supabase) {
      const user = (db.mockDb?.tenantUsers || []).find(u => u.tenant_id === tenant_id && (u.id === user_id || u.user_id === user_id));
      if (user) {
        user.temp_password = finalPassword;
        targetEmail = user.email || targetEmail;
        targetRole = user.role || targetRole;
      }
    } else {
      await db.supabase.auth.admin.updateUserById(user_id, {
        password: finalPassword,
        user_metadata: { initial_password: finalPassword }
      });
      await db.supabase.from('tenant_users').update({ temp_password: finalPassword }).eq('user_id', user_id);

      const { data: userData } = await db.supabase.auth.admin.getUserById(user_id);
      if (userData?.user?.email) targetEmail = userData.user.email;
    }

    const userObj = {
      tenant_id,
      user_id,
      email: targetEmail,
      role: targetRole,
      temp_password: finalPassword
    };

    const sharePackage = generateSharePackage(req, tenant, userObj);

    res.json({
      success: true,
      message: 'Password reset successfully',
      email: targetEmail,
      password: finalPassword,
      share_package: sharePackage
    });
  } catch (err) {
    console.error(`[POST /tenants/${req.params.tenant_id}/users/${req.params.user_id}/reset-password] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:tenant_id/users/:user_id — delete a client user account and revoke credentials
router.delete('/:tenant_id/users/:user_id', requireTenantAccess, async (req, res) => {
  try {
    const { tenant_id, user_id } = req.params;

    if (db.isMock || !db.supabase) {
      if (db.mockDb?.tenantUsers) {
        db.mockDb.tenantUsers = db.mockDb.tenantUsers.filter(tu => 
          !(tu.tenant_id === tenant_id && (tu.id === user_id || tu.user_id === user_id))
        );
      }
      return res.json({ success: true, message: 'User deleted successfully' });
    }

    // 1. Find user record first to get user_id if an internal row ID was passed
    let authUserId = user_id;
    const { data: existingRecord } = await db.supabase
      .from('tenant_users')
      .select('user_id')
      .eq('tenant_id', tenant_id)
      .or(`id.eq.${user_id},user_id.eq.${user_id}`)
      .maybeSingle();

    if (existingRecord?.user_id) {
      authUserId = existingRecord.user_id;
    }

    // 2. Delete from tenant_users table
    const { error: dbError } = await db.supabase
      .from('tenant_users')
      .delete()
      .eq('tenant_id', tenant_id)
      .or(`id.eq.${user_id},user_id.eq.${authUserId}`);
    if (dbError) throw dbError;

    // 3. Delete from Supabase Auth admin
    if (authUserId) {
      try {
        await db.supabase.auth.admin.deleteUser(authUserId);
      } catch (authErr) {
        console.warn(`[DELETE /tenants/${tenant_id}/users/${user_id}] Auth user deletion note:`, authErr.message);
      }
    }

    res.json({ success: true, message: 'User credential deleted successfully' });
  } catch (err) {
    console.error(`[DELETE /tenants/${req.params.tenant_id}/users/${req.params.user_id}] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// API KEY MANAGEMENT PER TENANT
// ─────────────────────────────────────────────

// GET /:tenant_id/keys — list API keys for a tenant
router.get('/:tenant_id/keys', requireTenantAccess, requireTenantRole('apikeys:manage'), async (req, res) => {
  try {
    const keys = await db.getApiKeysByTenant(req.params.tenant_id);
    res.json({ keys: keys || [] });
  } catch (err) {
    console.error(`[GET /tenants/${req.params.tenant_id}/keys] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// POST /:tenant_id/keys — generate a new API key
router.post('/:tenant_id/keys', requireTenantAccess, requireTenantRole('apikeys:manage'), async (req, res) => {
  try {
    const { description } = req.body;
    const key = await db.createApiKey(req.params.tenant_id, description || 'Dashboard Generated Key');
    res.status(201).json(key);
  } catch (err) {
    console.error(`[POST /tenants/${req.params.tenant_id}/keys] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /:tenant_id/keys/:keyId — revoke an API key
router.delete('/:tenant_id/keys/:keyId', requireTenantAccess, requireTenantRole('apikeys:manage'), async (req, res) => {
  try {
    const result = await db.revokeApiKey(req.params.tenant_id, req.params.keyId);
    if (!result) return res.status(404).json({ error: 'API key not found' });
    res.status(204).send();
  } catch (err) {
    console.error(`[DELETE /tenants/${req.params.tenant_id}/keys/${req.params.keyId}] Error:`, err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
