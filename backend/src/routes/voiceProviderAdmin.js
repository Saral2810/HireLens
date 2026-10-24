import express from 'express';
import { requireSuperAdmin } from '../middleware/auth.js';
import { encrypt, decrypt } from '../services/credentialCrypto.js';
import db from '../config/db.js';
import voiceProviderFactory, { createProviderFromCredentials, SUPPORTED_PROVIDERS } from '../services/voiceProvider/index.js';

const router = express.Router();

router.use(requireSuperAdmin);

// Mask credentials function
function maskString(str) {
  if (!str) return null;
  if (str.length <= 10) return '****';
  return `${str.substring(0, 4)}****${str.substring(str.length - 6)}`;
}


async function validateProviderCredentialsLive(provider_type, credentials) {
  // Minimal per-provider checks. Add more rules for Gnani once you know its credential fields.
  if (provider_type === 'gnani') {
    if (!credentials.api_key || credentials.api_key.length < 8) {
      return { success: false, error: 'api_key is required for gnani' };
    }
  }

  const provider = createProviderFromCredentials(provider_type, credentials);

  try {
    const timeoutPromise = new Promise((_, reject) => {
      const signal = AbortSignal.timeout(45000);
      const handleAbort = () => reject(new Error('Validation timeout after 45s'));
      if (signal.aborted) return handleAbort();
      signal.addEventListener('abort', handleAbort);
    });

    const agents = await Promise.race([provider.getAgents(), timeoutPromise]);
    
    return {
      success: true,
      agent_count: agents.length,
      sample_agent: agents.length > 0 ? (agents[0].name || agents[0].agent_name || 'Unknown') : null
    };
  } catch (err) {
    const detail = (err.message || String(err)).substring(0, 300);
    return {
      success: false,
      error: 'Provider authentication failed',
      detail
    };
  }
}

// GET /admin/voice-providers?tenant_id=X
router.get('/', async (req, res, next) => {
  try {
    const { tenant_id } = req.query;
    if (!tenant_id) {
      return res.status(400).json({ success: false, error: 'tenant_id is required' });
    }

    let data = [];
    if (!db.supabase) {
      data = (db.mockDb?.tenantVoiceProviders || [])
        .filter(p => p.tenant_id === tenant_id && !p.disabled_at);
    } else {
      const { data: dbData, error } = await db.supabase
        .from('tenant_voice_providers')
        .select('provider_type, is_default, encrypted_credentials, updated_at')
        .is('disabled_at', null)
        .eq('tenant_id', tenant_id);

      if (error) throw error;
      data = dbData || [];
    }

    const providers = data.map(row => {
      let credentials_summary = {};
      try {
        if (row.encrypted_credentials) {
          const creds = decrypt(row.encrypted_credentials);
          for (const [key, value] of Object.entries(creds)) {
            credentials_summary[key] = maskString(value);
          }
        }
      } catch (e) {
        console.error('Failed to decrypt credentials for summary', e);
      }

      return {
        provider_type: row.provider_type,
        is_default: row.is_default,
        credentials_summary,
        updated_at: row.updated_at
      };
    });

    res.json({ success: true, providers });
  } catch (error) {
    next(error);
  }
});

// POST /admin/voice-providers/test
router.post('/test', async (req, res, next) => {
  try {
    const { tenant_id, provider_type, credentials } = req.body;
    if (!tenant_id || !provider_type || !credentials) {
      return res.status(400).json({ success: false, error: 'tenant_id, provider_type, and credentials are required' });
    }
    
    if (!SUPPORTED_PROVIDERS.includes(provider_type)) {
      return res.status(400).json({ success: false, error: 'Invalid provider_type' });
    }

    const validationResult = await validateProviderCredentialsLive(provider_type, credentials);
    if (!validationResult.success) {
      return res.status(400).json(validationResult);
    }
    
    res.json(validationResult);
  } catch (error) {
    next(error);
  }
});

// POST /admin/voice-providers
router.post('/', async (req, res, next) => {
  try {
    const { tenant_id, provider_type, credentials } = req.body;
    if (!tenant_id || !provider_type || !credentials) {
      return res.status(400).json({ success: false, error: 'tenant_id, provider_type, and credentials are required' });
    }

    if (!SUPPORTED_PROVIDERS.includes(provider_type)) {
      return res.status(400).json({ success: false, error: 'Invalid provider_type' });
    }

    const validationResult = await validateProviderCredentialsLive(provider_type, credentials);
    if (!validationResult.success) {
      return res.status(400).json(validationResult);
    }

    const encrypted_credentials = encrypt(credentials);

    if (db.supabase) {
      const { count: defCount } = await db.supabase
        .from('tenant_voice_providers')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenant_id)
        .eq('is_default', true)
        .is('disabled_at', null);
      const isDefault = (defCount || 0) === 0;

      const { error } = await db.supabase
        .from('tenant_voice_providers')
        .upsert({
          tenant_id,
          provider_type,
          encrypted_credentials,
          is_default: isDefault,
          disabled_at: null,
          updated_at: new Date().toISOString()
        }, { onConflict: 'tenant_id, provider_type' });

      if (error) throw error;
    } else {
      if (!db.mockDb.tenantVoiceProviders) db.mockDb.tenantVoiceProviders = [];
      const hasDef = db.mockDb.tenantVoiceProviders.some(p => p.tenant_id === tenant_id && p.is_default && !p.disabled_at);
      const isDefault = !hasDef;
      const existing = db.mockDb.tenantVoiceProviders.find(p => p.tenant_id === tenant_id && p.provider_type === provider_type);
      if (existing) {
        existing.encrypted_credentials = encrypted_credentials;
        existing.disabled_at = null;
        existing.updated_at = new Date().toISOString();
        if (existing.is_default === undefined) existing.is_default = isDefault;
      } else {
        db.mockDb.tenantVoiceProviders.push({
          tenant_id,
          provider_type,
          encrypted_credentials,
          is_default: isDefault,
          disabled_at: null,
          updated_at: new Date().toISOString()
        });
      }
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});


// GET /admin/voice-providers/:tenant_id/:provider_type/dependencies
router.get('/:tenant_id/:provider_type/dependencies', async (req, res, next) => {
  try {
    const { tenant_id, provider_type } = req.params;
    if (!db.supabase) return res.json({ campaigns: [], queued_calls: 0, in_flight_sessions: 0, total_leads_affected: 0 });

    const { data: campaigns, error: campErr } = await db.supabase
      .from('campaigns')
      .select('id, name, status')
      .eq('tenant_id', tenant_id)
      .eq('voice_provider', provider_type)
      .in('status', ['active', 'draft', 'paused']);

    if (campErr) throw campErr;
    if (!campaigns || campaigns.length === 0) {
      return res.json({ campaigns: [], queued_calls: 0, in_flight_sessions: 0, total_leads_affected: 0 });
    }
    const campaignIds = campaigns.map(c => c.id);

    const { count: queuedCount, error: qErr } = await db.supabase
      .from('call_queue')
      .select('*', { count: 'exact', head: true })
      .in('campaign_id', campaignIds);
    if (qErr) throw qErr;

    const { count: inFlightCount, error: ifErr } = await db.supabase
      .from('call_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('tenant_id', tenant_id)
      .is('ended_at', null)
      .in('campaign_id', campaignIds);
    if (ifErr) throw ifErr;

    res.json({
      campaigns,
      queued_calls: queuedCount || 0,
      in_flight_sessions: inFlightCount || 0,
      total_leads_affected: (queuedCount || 0) + (inFlightCount || 0)
    });
  } catch (error) {
    next(error);
  }
});

// DELETE /admin/voice-providers/:tenant_id/:provider_type
router.delete('/:tenant_id/:provider_type', async (req, res, next) => {
  try {
    const { tenant_id, provider_type } = req.params;
    const force = req.query.force === 'true';
    
    if (db.supabase) {
      // 1. Dependency check
      const { data: campaigns } = await db.supabase
        .from('campaigns')
        .select('id, name, status')
        .eq('tenant_id', tenant_id)
        .eq('voice_provider', provider_type)
        .in('status', ['active', 'draft', 'paused']);

      let hasDependencies = false;
      let blocked_by = { campaigns: [], queued_calls: 0, in_flight_sessions: 0, total_leads_affected: 0 };
      
      if (campaigns && campaigns.length > 0) {
        const campaignIds = campaigns.map(c => c.id);
        const { count: queuedCount } = await db.supabase.from('call_queue').select('*', { count: 'exact', head: true }).in('campaign_id', campaignIds);
        const { count: inFlightCount } = await db.supabase.from('call_sessions').select('*', { count: 'exact', head: true }).eq('tenant_id', tenant_id).is('ended_at', null).in('campaign_id', campaignIds);
        
        blocked_by = {
          campaigns,
          queued_calls: queuedCount || 0,
          in_flight_sessions: inFlightCount || 0,
          total_leads_affected: (queuedCount || 0) + (inFlightCount || 0)
        };
        hasDependencies = campaigns.length > 0 || blocked_by.total_leads_affected > 0;
      }

      if (hasDependencies && !force) {
        return res.status(409).json({ blocked_by });
      }

      // 2. Disable provider (Soft Delete)
      const { error: updateErr } = await db.supabase
        .from('tenant_voice_providers')
        .update({ disabled_at: new Date().toISOString() })
        .eq('tenant_id', tenant_id)
        .eq('provider_type', provider_type);

      if (updateErr) throw updateErr;

      // 3. If force=true and dependencies existed, pause campaigns and cancel queue
      if (hasDependencies && force) {
        const campaignIds = campaigns.map(c => c.id);
        
        await db.supabase
          .from('campaigns')
          .update({ status: 'paused' })
          .eq('tenant_id', tenant_id)
          .eq('voice_provider', provider_type)
          .eq('status', 'active');
          
        await db.supabase
          .from('call_queue')
          .update({ status: 'canceled', last_dial_error: 'provider_removed' })
          .in('campaign_id', campaignIds);
          
        console.warn(`[voiceProviderAdmin] Force removed provider ${provider_type} for tenant ${tenant_id}. Paused affected campaigns and canceled queue.`);
      }
    } else {
      if (!db.mockDb.tenantVoiceProviders) db.mockDb.tenantVoiceProviders = [];
      const prov = db.mockDb.tenantVoiceProviders.find(p => p.tenant_id === tenant_id && p.provider_type === provider_type);
      if (prov) {
        prov.disabled_at = new Date().toISOString();
      }
    }

    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});


// POST /admin/test-outbound-call

export default router;
