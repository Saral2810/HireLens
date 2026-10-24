import express from 'express';
import { getProvider } from '../services/voiceProvider/index.js';
import db from '../config/db.js';
import { autoSuggestMappings } from '../services/variableMapping/index.js';

const router = express.Router();

const resolveTenantId = (req) => {
  return req.tenant_id || req.user?.mockTenant || req.user?.tenant_id || req.query.tenant_id || req.body?.tenant_id;
};

/**
 * GET /admin/agents
 * Lists voice agents from the configured provider(s) via each adapter's getAgents().
 */
router.get('/', async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req) || null;
    const providerType = req.query.provider || process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
    let agents = [];
    try {
      const voiceProvider = await getProvider(tenantId, providerType);
      agents = (await voiceProvider.getAgents()) || [];
    } catch (e) {
      console.warn(`[GET /admin/agents] Could not list agents for ${providerType}:`, e.message);
    }
    res.json({
      success: true,
      agents: agents.map(a => ({
        id: a.id || a.agent_id,
        name: a.name || a.agent_name || a.agent_id,
        provider_type: providerType,
        provider: providerType,
        description: a.description || '',
        language: a.configuration?.language || a.language || null,
        is_active: a.is_active !== false
      }))
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /admin/agents/test-call
 * Places a single test call with an agent. Body: { phone, agent_id, provider? }
 */
router.post('/test-call', async (req, res, next) => {
  try {
    const tenantId = resolveTenantId(req);
    if (!tenantId) return res.status(400).json({ error: 'tenant_id is required' });
    const { phone, to_number, agent_id, agentId, provider, voice_provider } = req.body;
    const destPhone = phone || to_number;
    const targetAgentId = agent_id || agentId;
    const targetProvider = provider || voice_provider || process.env.DEFAULT_VOICE_PROVIDER || 'gnani';

    if (!destPhone) {
      return res.status(400).json({ error: 'Phone number is required' });
    }
    if (!targetAgentId) {
      return res.status(400).json({ error: 'agent_id is required' });
    }

    const voiceProvider = await getProvider(tenantId, targetProvider);
    const fakeLead = {
      id: 'test-call-' + Date.now(),
      phone: destPhone,
      tenant_id: tenantId,
      name: 'Test Prospect'
    };

    const appUrl = (process.env.PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/+$/, '');
    const webhookUrl = `${appUrl}/leads/webhook/${targetProvider}?tenant_id=${encodeURIComponent(tenantId)}`;

    const result = await voiceProvider.initSession(fakeLead, { voice_agent_id: targetAgentId }, webhookUrl);
    const realCallId = result.provider_session_id;

    if (db.supabase) {
      await db.insertCallSession({
        tenant_id: tenantId,
        lead_id: fakeLead.id,
        provider_session_id: realCallId,
        disposition: 'calling'
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: `Test call dispatched to ${destPhone} with agent ${targetAgentId}.`,
      call_id: realCallId,
      provider_session_id: realCallId
    });
  } catch (err) {
    next(err);
  }
});

router.get('/:provider/:agentId/variables', async (req, res, next) => {
  try {
    const { provider, agentId } = req.params;
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }
    
    // get expected
    const voiceProvider = await getProvider(tenantId, provider);
    const expected = await voiceProvider.getAgentExpectedVariables(agentId);
    
    // get current
    let current_mappings = [];
    if (db.supabase && !db.isMock) {
      const { data, error } = await db.supabase
        .from('agent_variable_mappings')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('provider_type', provider)
        .eq('agent_id', agentId);
        
      if (error) throw error;
      current_mappings = data || [];
    } else {
      current_mappings = (db.mockDb?.agentVariableMappings || []).filter(
        m => m.tenant_id === tenantId && m.provider_type === provider && m.agent_id === agentId
      );
    }
    
    // get sample lead
    let sampleLead = null;
    if (db.supabase && !db.isMock) {
      const { data: sampleLeads } = await db.supabase
        .from('leads')
        .select('*')
        .eq('tenant_id', tenantId)
        .limit(1);
      sampleLead = sampleLeads?.[0] || null;
    } else {
      sampleLead = (db.mockDb?.leads || []).find(l => l.tenant_id === tenantId) || null;
    }
      
    let suggestions = [];
    if (sampleLead) {
      suggestions = await autoSuggestMappings(tenantId, provider, agentId, sampleLead);
    }
    
    res.json({ expected, current_mappings, suggestions });
  } catch (err) {
    next(err);
  }
});

router.put('/:provider/:agentId/variables', async (req, res, next) => {
  try {
    const { provider, agentId } = req.params;
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }
    const { mappings } = req.body;
    
    if (!mappings || !Array.isArray(mappings)) {
      return res.status(400).json({ error: 'mappings must be an array' });
    }
    
    if (db.supabase && !db.isMock) {
      // delete existing
      await db.supabase
        .from('agent_variable_mappings')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('provider_type', provider)
        .eq('agent_id', agentId);
        
      // insert new
      if (mappings.length > 0) {
        const inserts = mappings.map(m => ({
          tenant_id: tenantId,
          provider_type: provider,
          agent_id: agentId,
          target_variable: m.target_variable,
          source_expression: m.source_expression,
          transform: m.transform || null,
          is_required: m.is_required !== undefined ? m.is_required : true
        }));
        
        const { error } = await db.supabase.from('agent_variable_mappings').insert(inserts);
        if (error) throw error;
      }
    } else {
      db.mockDb.agentVariableMappings = (db.mockDb.agentVariableMappings || []).filter(
        m => !(m.tenant_id === tenantId && m.provider_type === provider && m.agent_id === agentId)
      );
      if (mappings.length > 0) {
        const inserts = mappings.map(m => ({
          tenant_id: tenantId,
          provider_type: provider,
          agent_id: agentId,
          target_variable: m.target_variable,
          source_expression: m.source_expression,
          transform: m.transform || null,
          is_required: m.is_required !== undefined ? m.is_required : true
        }));
        db.mockDb.agentVariableMappings.push(...inserts);
      }
    }
    
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

router.post('/:provider/:agentId/variables/auto-map', async (req, res, next) => {
  try {
    const { provider, agentId } = req.params;
    const tenantId = resolveTenantId(req);
    if (!tenantId) {
      return res.status(400).json({ error: 'tenant_id is required' });
    }
    
    let sampleLead = null;
    if (db.supabase && !db.isMock) {
      const { data: sampleLeads } = await db.supabase
        .from('leads')
        .select('*')
        .eq('tenant_id', tenantId)
        .limit(1);
      sampleLead = sampleLeads?.[0] || null;
    } else {
      sampleLead = (db.mockDb?.leads || []).find(l => l.tenant_id === tenantId) || null;
    }
      
    if (!sampleLead) {
      return res.status(400).json({ error: 'No sample leads available to generate auto-mapping' });
    }
    
    const suggestions = await autoSuggestMappings(tenantId, provider, agentId, sampleLead);
    
    const mappings = suggestions.map(s => ({
      tenant_id: tenantId,
      provider_type: provider,
      agent_id: agentId,
      target_variable: s.target_variable,
      source_expression: s.suggested_source,
      is_required: true // default
    }));
    
    if (mappings.length > 0) {
      if (db.supabase && !db.isMock) {
        await db.supabase
          .from('agent_variable_mappings')
          .delete()
          .eq('tenant_id', tenantId)
          .eq('provider_type', provider)
          .eq('agent_id', agentId);
          
        await db.supabase.from('agent_variable_mappings').insert(mappings);
      } else {
        db.mockDb.agentVariableMappings = (db.mockDb.agentVariableMappings || []).filter(
          m => !(m.tenant_id === tenantId && m.provider_type === provider && m.agent_id === agentId)
        );
        db.mockDb.agentVariableMappings.push(...mappings);
      }
    }
    
    res.json({ success: true, mapped_count: mappings.length });
  } catch (err) {
    next(err);
  }
});

export default router;
