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

import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';
import { candidateColumns } from '../utils/validation.js';

dotenv.config();

// All credentials come ONLY from your .env file. No hardcoded fallbacks.
const supabaseUrl = process.env.SUPABASE_URL || '';

let rawServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
// Safeguard: the backend needs a service-role / secret key, not a publishable/anon key
if (rawServiceKey && (rawServiceKey.startsWith('sb_publishable_') || rawServiceKey.includes('"role":"anon"'))) {
  console.warn('[DB Config] WARNING: SUPABASE_SERVICE_ROLE_KEY looks like a publishable/anon key. Use the service-role (secret) key for the backend.');
  rawServiceKey = '';
}
const supabaseKey = rawServiceKey;

export const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || '';
export const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || '';
export const supabaseJwksUrl = process.env.SUPABASE_JWKS_URL || (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : '');

const isTestRunnerActive = process.env.NODE_ENV === 'test' || process.argv.some(arg => arg.includes('test') || arg.includes('--test'));
const isSupabaseConfigured = !!supabaseUrl && !!supabaseKey;

// The shared client must keep using the service-role key. supabase-js sends a stored session's
// token instead of the key, so it must never hold a session (see createAuthClient below).
const SERVER_AUTH_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/**
 * Throwaway client for user sign-in. Signing in on the shared client would switch every later
 * query to that user's token (and RLS).
 * @returns {import('@supabase/supabase-js').SupabaseClient|null}
 */
export function createAuthClient() {
  if (!isSupabaseConfigured) return null;
  return createClient(supabaseUrl, supabaseKey, SERVER_AUTH_OPTIONS);
}

let supabase = null;
if (isSupabaseConfigured && !isTestRunnerActive) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, SERVER_AUTH_OPTIONS);
    console.log('Successfully initialized Supabase client.');
  } catch (error) {
    console.error('Failed to initialize Supabase client:', error);
  }
} else {
  console.log('Supabase credentials not set or test runner active. Running in offline MOCK database mode.');
}

// In-Memory Database for Mock Mode
const mockDb = {
  leads: [],
  tenantConfigs: {},
  configAuditLog: [],
  callSessions: [],
  callEvents: [],
  auditTrail: [],
  dncRegistry: [],
  scripts: [],
  agentBriefs: [],
  jobs: [],
  campaigns: [],
  campaignDrafts: [],
  leadIngestionErrors: [],
  leadCampaigns: [],
  leadNotes: [],
  apiKeys: [],
  callQueue: [],
  tenantVoiceProviders: [],
  external_call_logs: [],
  tenantUsers: [
    {
      id: 'usr_demo_01',
      tenant_id: 'demo',
      user_id: 'mock-user-demo-01',
      email: 'admin@demo.local',
      role: 'admin',
      temp_password: 'ChangeMe@123',
      created_at: new Date().toISOString()
    }
  ]
};

// Seed default configs for tenant 'default-tenant' and 'test-tenant'
const DEFAULT_WEIGHTS = {
  demographic_fit: 0.25,
  source_quality: 0.25,
  recency: 0.20,
  behavioural_signals: 0.15,
  prior_interaction: 0.15
};

mockDb.tenantConfigs['default'] = {
  tenant_id: 'default',
  name: 'Default Workspace',
  tenant_tag: 'tag_def_01',
  status: 'active',
  scoring_weights: { ...DEFAULT_WEIGHTS },
  onboarding_config: {
    industry: 'General Sales',
    objective: 'Outbound sales and lead qualification campaigns.',
    thresholds: { hot: 80, warm: 50 },
    custom_scoring_rules: []
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

mockDb.tenantConfigs['default-tenant'] = {
  tenant_id: 'default-tenant',
  name: 'Default Tenant',
  tenant_tag: 'defaulttag',
  scoring_weights: { ...DEFAULT_WEIGHTS },
  onboarding_config: {
    llm_system_prompt: 'You are an AI transcript analyst for an an outbound sales and lead qualification platform.\nAnalyze the conversation between the sales agent and the customer. Be specific, concise, and useful to a sales follow-up team.\nReturn a JSON object strictly following this schema:\n{\n  "sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL",\n  "summary": { "call_purpose": "1 sentence.", "customer_response": "1 sentence.", "outcome": "1-2 sentences." },\n  "analysis": { "call_outcome": "Brief summary", "engagement_level": "HIGH" | "MEDIUM" | "LOW", "follow_up_required": true | false }\n}',
    thresholds: { hot: 80, warm: 50 },
    custom_scoring_rules: [
      { field: 'business_type', type: 'match', value: 'Business', points: 15 },
      { field: 'product_type', type: 'match', value: 'premium', points: 15 }
    ]
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

mockDb.tenantConfigs['test-tenant'] = {
  tenant_id: 'test-tenant',
  name: 'Test Tenant',
  tenant_tag: 'testtag',
  scoring_weights: { ...DEFAULT_WEIGHTS },
  onboarding_config: {
    llm_system_prompt: 'You are an AI transcript analyst for an an outbound sales and lead qualification platform.\nAnalyze the conversation between the sales agent and the customer. Be specific, concise, and useful to a sales follow-up team.\nReturn a JSON object strictly following this schema:\n{\n  "sentiment": "POSITIVE" | "NEGATIVE" | "NEUTRAL",\n  "summary": { "call_purpose": "1 sentence.", "customer_response": "1 sentence.", "outcome": "1-2 sentences." },\n  "analysis": { "call_outcome": "Brief summary", "engagement_level": "HIGH" | "MEDIUM" | "LOW", "follow_up_required": true | false }\n}',
    thresholds: { hot: 80, warm: 50 },
    custom_scoring_rules: [
      { field: 'business_type', type: 'match', value: 'Business', points: 15 },
      { field: 'product_type', type: 'match', value: 'premium', points: 15 }
    ]
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

mockDb.tenantConfigs['demo'] = {
  tenant_id: 'demo',
  name: 'Demo Workspace',
  tenant_tag: 'tag_demo_01',
  status: 'active',
  scoring_weights: { ...DEFAULT_WEIGHTS },
  aiAgent: {
    persona: 'You are an AI voice agent. Always disclose that you are an AI assistant at the start of the call and offer to connect the customer to a human.',
    disclosureRequired: true,
    voiceProvider: 'gnani'
  },
  queue: { maxAttempts: 4, prioritizeByExpiry: true },
  crm: { dataMinimization: false, allowedSyncFields: [] },
  onboarding_config: {
    industry: 'General',
    objective: 'Outbound voice campaigns.',
    thresholds: { hot: 80, warm: 50 },
    custom_scoring_rules: []
  },
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

mockDb.apiKeys.push({
  id: uuidv4(),
  tenant_id: 'default-tenant',
  api_key: 'key_default',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
});

mockDb.apiKeys.push({
  id: uuidv4(),
  tenant_id: 'test-tenant',
  api_key: 'key_test',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
});


const db = {
  isMock: !supabase,
  supabase,
  mockDb,

  async getTenantByApiKey(apiKey) {
    if (supabase) {
      const { data, error } = await supabase
        .from('api_keys')
        .select('tenant_id')
        .eq('api_key', apiKey)
        .maybeSingle();
      if (error) throw error;
      return data ? data.tenant_id : null;
    } else {
      const record = mockDb.apiKeys.find(k => k.api_key === apiKey);
      return record ? record.tenant_id : null;
    }
  },

  async getTenantByTenantTag(tenantTag) {
    if (supabase) {
      const { data, error } = await supabase
        .from('tenant_configs')
        .select('*')
        .eq('tenant_tag', tenantTag)
        .maybeSingle();
      if (error) throw error;
      return data;
    } else {
      for (const tId in mockDb.tenantConfigs) {
        if (mockDb.tenantConfigs[tId].tenant_tag === tenantTag) {
          return mockDb.tenantConfigs[tId];
        }
      }
      return null;
    }
  },

  async insertTenantUser(tenantId, userId, role = 'admin', email = null, password = null) {
    const finalPassword = password || ('Pass@' + Math.random().toString(36).slice(-6) + '!');
    if (supabase) {
      const { data, error } = await supabase
        .from('tenant_users')
        .insert({
          tenant_id: tenantId,
          user_id: userId,
          role,
          email,
          temp_password: finalPassword
        })
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const user = {
        id: uuidv4(),
        tenant_id: tenantId,
        user_id: userId,
        role,
        email,
        temp_password: finalPassword,
        created_at: new Date().toISOString()
      };
      mockDb.tenantUsers.push(user);
      return user;
    }
  },

  async getApiKeysByTenant(tenantId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('api_keys')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    } else {
      return mockDb.apiKeys
        .filter(k => k.tenant_id === tenantId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
  },

  async createApiKey(tenantId, description = 'Dashboard Generated Key') {
    const keyString = 'api_key_' + Math.random().toString(36).substr(2, 24);
    const newKey = {
      id: uuidv4(),
      tenant_id: tenantId,
      api_key: keyString,
      description,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (supabase) {
      const { data, error } = await supabase
        .from('api_keys')
        .insert(newKey)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      mockDb.apiKeys.push(newKey);
      return newKey;
    }
  },

  async revokeApiKey(tenantId, keyId) {
    if (supabase) {
      const { error } = await supabase
        .from('api_keys')
        .delete()
        .eq('id', keyId)
        .eq('tenant_id', tenantId);
      if (error) throw error;
      return true;
    } else {
      const initialLength = mockDb.apiKeys.length;
      mockDb.apiKeys = mockDb.apiKeys.filter(k => !(k.id === keyId && k.tenant_id === tenantId));
      return mockDb.apiKeys.length < initialLength;
    }
  },

  async getWeights(tenantId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('tenant_configs')
        .select('scoring_weights')
        .eq('tenant_id', tenantId)
        .single();
      
      if (error && error.code !== 'PGRST116') { // PGRST116 is "no rows returned"
        throw error;
      }
      return data ? data.scoring_weights : DEFAULT_WEIGHTS;
    } else {
      const config = mockDb.tenantConfigs[tenantId];
      return config ? config.scoring_weights : DEFAULT_WEIGHTS;
    }
  },

  async upsertWeights(tenantId, weights, changedBy = 'system') {
    const oldWeights = await this.getWeights(tenantId);
    if (supabase) {
      // Upsert weights
      const { error: upsertError } = await supabase
        .from('tenant_configs')
        .upsert({
          tenant_id: tenantId,
          scoring_weights: weights,
          updated_at: new Date().toISOString()
        }, { onConflict: 'tenant_id' });
      if (upsertError) throw upsertError;

      // Log config change
      const { error: logError } = await supabase
        .from('config_audit_log')
        .insert({
          tenant_id: tenantId,
          changed_by: changedBy,
          config_type: 'scoring_weights',
          old_value: oldWeights,
          new_value: weights
        });
      if (logError) throw logError;
    } else {
      mockDb.tenantConfigs[tenantId] = {
        ...(mockDb.tenantConfigs[tenantId] || {}),
        tenant_id: tenantId,
        scoring_weights: weights,
        created_at: mockDb.tenantConfigs[tenantId]?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      mockDb.configAuditLog.push({
        id: uuidv4(),
        tenant_id: tenantId,
        changed_by: changedBy,
        config_type: 'scoring_weights',
        old_value: oldWeights,
        new_value: weights
      });
    }
  },

  async getLeadByIdGlobally(leadId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('id', leadId)
        .maybeSingle();
      if (error && error.code !== '42P01') throw error;
      if (error && error.code === '42P01') {
        return mockDb.leads.find(l => l.id === leadId) || null;
      }
      return data;
    } else {
      return mockDb.leads.find(l => l.id === leadId) || null;
    }
  },



  async getAllTenantConfigs() {
    if (supabase) {
      // Use .or() because .neq() in PostgREST does NOT include NULL rows — tenants
      // seeded without an explicit status would be silently excluded otherwise.
      const { data, error } = await supabase
        .from('tenant_configs')
        .select('*')
        .or('status.neq.deleted,status.is.null');
      if (error) throw error;
      return data || [];
    } else {
      return Object.values(mockDb.tenantConfigs).filter(t => t.status !== 'deleted');
    }
  },

  async getTenantsForUser(userId, isSuperAdmin) {
    if (isSuperAdmin) {
      return this.getAllTenantConfigs();
    }
    if (supabase) {
      const { data, error } = await supabase
        .from('tenant_users')
        .select(`
          tenant_id,
          role,
          tenant_configs (*)
        `)
        .eq('user_id', userId);
      
      if (error) throw error;
      
      return data
        .filter(tu => tu.tenant_configs && tu.tenant_configs.status !== 'deleted')
        .map(tu => ({
          ...tu.tenant_configs,
          user_role: tu.role
        }));
    } else {
      const userRecords = mockDb.tenantUsers.filter(tu =>
        tu.user_id === userId || tu.id === userId || tu.email === userId
      );

      if (userRecords.length === 0) {
        return this.getAllTenantConfigs();
      }

      return userRecords
        .map(tu => {
          const cfg = mockDb.tenantConfigs[tu.tenant_id];
          return cfg && cfg.status !== 'deleted' ? { ...cfg, user_role: tu.role } : null;
        })
        .filter(Boolean);
    }
  },

  async getTenantConfigById(tenantId) {
    if (supabase) {
      // Use .or() because .neq() in PostgREST does NOT include NULL rows.
      // Use .maybeSingle() to gracefully return null instead of throwing PGRST116.
      let { data, error } = await supabase
        .from('tenant_configs')
        .select('*')
        .eq('tenant_id', tenantId)
        .or('status.neq.deleted,status.is.null')
        .maybeSingle();
      if (error) throw error;
      
      if (data && !data.tenant_tag) {
        const newTenantTag = 'tag' + Math.random().toString(36).substr(2, 6);
        console.log(`[Auto-Migration] Assigning tenant_tag ${newTenantTag} to tenant ${tenantId}`);
        await supabase.from('tenant_configs').update({ tenant_tag: newTenantTag }).eq('tenant_id', tenantId);
        data.tenant_tag = newTenantTag;
      }
      return data;
    } else {
      return mockDb.tenantConfigs[tenantId] || null;
    }
  },

  async upsertTenantConfig(tenantId, configData) {
    if (supabase) {
      const { error } = await supabase
        .from('tenant_configs')
        .upsert({
          tenant_id: tenantId,
          ...configData,
          updated_at: new Date().toISOString()
        }, { onConflict: 'tenant_id' });
      if (error) throw error;
      return await this.getTenantConfigById(tenantId);
    } else {
      mockDb.tenantConfigs[tenantId] = {
        ...mockDb.tenantConfigs[tenantId],
        ...configData,
        tenant_id: tenantId,
        created_at: mockDb.tenantConfigs[tenantId]?.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      return mockDb.tenantConfigs[tenantId];
    }
  },

  async deleteTenantConfig(tenantId) {
    if (supabase) {
      const { error } = await supabase
        .from('tenant_configs')
        .update({ status: 'deleted' })
        .eq('tenant_id', tenantId);
      if (error) throw error;
      return true;
    } else {
      if (mockDb.tenantConfigs[tenantId]) {
        mockDb.tenantConfigs[tenantId].status = 'deleted';
        return true;
      }
      return false;
    }
  },

  // Partial update — use for status changes, lightweight patches (not full config replaces)
  async updateTenantConfig(tenantId, fields) {
    if (supabase) {
      const { error } = await supabase
        .from('tenant_configs')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId);
      if (error) throw error;
      return true;
    } else {
      if (mockDb.tenantConfigs[tenantId]) {
        Object.assign(mockDb.tenantConfigs[tenantId], fields, { updated_at: new Date().toISOString() });
        return true;
      }
      return false;
    }
  },

  async findLeadByPhone(tenantId, phone) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('phone', phone)
        .maybeSingle();
      if (error) throw error;
      return data;
    } else {
      return mockDb.leads.find(l => l.tenant_id === tenantId && l.phone === phone) || null;
    }
  },

  async findLeadsByPhones(tenantId, phones) {
    if (!phones || phones.length === 0) return [];
    if (supabase) {
      const CHUNK = 1000;
      const allResults = [];
      for (let i = 0; i < phones.length; i += CHUNK) {
        const slice = phones.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('leads')
          .select('*')
          .eq('tenant_id', tenantId)
          .in('phone', slice);
        if (error) throw error;
        if (data) allResults.push(...data);
      }
      return allResults;
    } else {
      const phoneSet = new Set(phones);
      return mockDb.leads.filter(l => l.tenant_id === tenantId && phoneSet.has(l.phone));
    }
  },

  async findLeadById(id) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data;
    } else {
      return mockDb.leads.find(l => l.id === id) || null;
    }
  },

  async insertLead(lead) {
    const leadId = lead.id || uuidv4();
    const rawData = lead.raw_data || {};
    if (rawData.initial_score === undefined || rawData.initial_score === null) {
      rawData.initial_score = lead.score || 0;
    }
    const newLead = {
      id: leadId,
      tenant_id: lead.tenant_id,
      name: lead.name || null,
      phone: lead.phone,
      email: lead.email || null,
      source: lead.source,
      raw_data: rawData,
      score: lead.score || 0,
      status: lead.status || 'ingested',
      dataset_id: lead.dataset_id || null,
      campaign_name: lead.campaign_name || null,
      client_id: lead.client_id || null,
      priority_band: lead.priority_band || rawData.priority_band || null,
      offer_amount: lead.offer_amount || rawData.offer_amount || null,
      offer_expiry_date: lead.offer_expiry_date || rawData.offer_expiry_date || null,
      ...candidateColumns(lead),
      created_at: lead.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .insert(newLead)
        .select()
        .single();
      if (error) {
        if (error.code === '23505' || error.message?.includes('duplicate key value violates unique constraint')) {
          const err = new Error('Duplicate lead found');
          err.code = '23505';
          throw err;
        }
        throw error;
      }
      return data;
    } else {
      // Check duplicate
      const duplicate = mockDb.leads.find(
        l => l.tenant_id === newLead.tenant_id && l.phone === newLead.phone
      );
      if (duplicate) {
        const err = new Error('Duplicate lead found');
        err.code = '23505';
        throw err;
      }
      mockDb.leads.push(newLead);
      return newLead;
    }
  },

  async insertLeads(leads) {
    if (!leads || leads.length === 0) return [];
    const now = new Date().toISOString();
    const formattedLeads = leads.map(lead => {
      const leadId = lead.id || uuidv4();
      const rawData = lead.raw_data || {};
      if (rawData.initial_score === undefined || rawData.initial_score === null) {
        rawData.initial_score = lead.score || 0;
      }
      return {
        id: leadId,
        tenant_id: lead.tenant_id,
        name: lead.name || null,
        phone: lead.phone,
        email: lead.email || null,
        source: lead.source,
        raw_data: rawData,
        score: lead.score || 0,
        status: lead.status || 'ingested',
        dataset_id: lead.dataset_id || null,
        campaign_name: lead.campaign_name || null,
        client_id: lead.client_id || null,
        priority_band: lead.priority_band || rawData.priority_band || null,
        offer_amount: lead.offer_amount || rawData.offer_amount || null,
        offer_expiry_date: lead.offer_expiry_date || rawData.offer_expiry_date || null,
        ...candidateColumns(lead),
        created_at: lead.created_at || now,
        updated_at: now
      };
    });

    if (supabase) {
      const CHUNK = 1000;
      const insertedResults = [];
      for (let i = 0; i < formattedLeads.length; i += CHUNK) {
        const slice = formattedLeads.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('leads')
          .upsert(slice, { onConflict: 'tenant_id,phone', ignoreDuplicates: true })
          .select();
        if (error) {
          if (error.code === '23505' || error.message?.includes('duplicate key value violates unique constraint')) {
            console.warn(`[DB] Duplicate key in batch slice at index ${i}, falling back to single inserts for this slice`);
            for (const singleLead of slice) {
              try {
                const { data: sData, error: sErr } = await supabase.from('leads').insert(singleLead).select().single();
                if (!sErr && sData) insertedResults.push(sData);
              } catch (e) {
                // Ignore duplicates
              }
            }
          } else {
            throw error;
          }
        } else if (data) {
          insertedResults.push(...data);
        }
      }
      return insertedResults;
    } else {
      mockDb.leads.push(...formattedLeads);
      return formattedLeads;
    }
  },

  async insertLeadNote(tenantId, leadId, text, agentId = 'system') {
    const note = {
      id: uuidv4(),
      tenant_id: tenantId,
      lead_id: leadId,
      agent_id: agentId,
      note_text: text,
      created_at: new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase
        .from('lead_notes')
        .insert(note)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      mockDb.leadNotes.push(note);
      return note;
    }
  },

  async getLeadNotes(tenantId, leadId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('lead_notes')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('lead_id', leadId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data;
    } else {
      return mockDb.leadNotes
        .filter(n => n.tenant_id === tenantId && n.lead_id === leadId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
  },

  async updateLeadScore(id, score) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .update({ score, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const lead = mockDb.leads.find(l => l.id === id);
      if (!lead) throw new Error('Lead not found');
      lead.score = score;
      lead.updated_at = new Date().toISOString();
      return lead;
    }
  },

  async updateLeadStatus(id, status) {
    let oldStatus = 'unknown';
    let tenantId = null;
    try {
      const lead = await this.findLeadById(id);
      if (lead) {
        oldStatus = lead.status;
        tenantId = lead.tenant_id;
      }
    } catch (err) {
      console.error('Error finding lead for status update audit:', err);
    }

    let result;
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .update({ status, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const lead = mockDb.leads.find(l => l.id === id);
      if (!lead) throw new Error('Lead not found');
      lead.status = status;
      lead.updated_at = new Date().toISOString();
      result = lead;
    }

    if (tenantId && oldStatus !== status) {
      try {
        let reason = `Status transitioned from ${oldStatus} to ${status}`;
        if (status === 'queued') reason = 'Lead enqueued for dialing';
        else if (status === 'calling') reason = 'Call initiated by outbound system';
        else if (status === 'called') reason = 'Call completed';
        else if (status === 'dnc') reason = 'DNC registration matched and blocked';
        else if (status === 'closed') reason = 'Lead closed (max dial attempts reached)';
        else if (status === 'hot_escalated') reason = 'AI detected high intent and escalated lead';

        await this.insertAuditLog(tenantId, 'disposition_changed', {
          lead_id: id,
          old_status: oldStatus,
          new_status: status,
          reason,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('Failed to insert disposition_changed audit log:', err);
      }
    }

    return result;
  },

  async updateLead(id, updates) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const lead = mockDb.leads.find(l => l.id === id);
      if (lead) {
        Object.assign(lead, updates, { updated_at: new Date().toISOString() });
      }
      return lead;
    }
  },

  async enqueueToDialer(tenantId, leadId, phone, campaignName, nextAttemptAt = null, attemptNumber = 1) {
    if (!supabase) {
      const q = { tenant_id: tenantId, lead_id: leadId, phone, campaign_name: campaignName, status: 'queued' };
      if (campaignName && mockDb.campaigns) {
        const camp = mockDb.campaigns.find(c => c.name === campaignName || c.id === campaignName);
        if (camp) q.campaign_id = camp.id;
      }
      if (!Array.isArray(mockDb.callQueue)) mockDb.callQueue = [];
      mockDb.callQueue.push(q);
      return q;
    }

    try {
      // 1. Resolve a valid campaign UUID
      let campaignId = null;
      
      const { data: campaigns, error: campErr } = await supabase
        .from('campaigns')
        .select('id, name')
        .eq('tenant_id', tenantId);

      if (!campErr && campaigns && campaigns.length > 0) {
        if (campaignName) {
           const parsedName = String(campaignName).split(',')[0].trim().toLowerCase();
           const match = campaigns.find(c => 
             c.id === parsedName || 
             c.name.toLowerCase() === parsedName ||
             c.name.toLowerCase().replace(/\s+/g, '') === parsedName.replace(/\s+/g, '')
           );
           if (match) campaignId = match.id;
        }
        if (!campaignId) campaignId = campaigns[0].id;
      }

      // If absolutely no campaigns exist for this tenant, create a default one
      if (!campaignId) {
        const { data: newCamp } = await supabase
          .from('campaigns')
          .insert({ tenant_id: tenantId, name: 'Default AI Campaign' })
          .select('id')
          .single();
        if (newCamp) campaignId = newCamp.id;
      }

      // 2. Resolve active_lead(s) (prevent and resolve duplicate rows for the same lead and campaign)
      let activeLeadId = null;
      const { data: allActiveLeads } = await supabase
        .from('active_leads')
        .select('active_lead_id')
        .eq('campaign_id', campaignId)
        .eq('lead_id', leadId)
        .order('created_at', { ascending: false });

      const allActiveLeadIds = (allActiveLeads || []).map(a => a.active_lead_id);

      if (allActiveLeadIds.length > 0) {
        activeLeadId = allActiveLeadIds[0];
        await supabase
          .from('active_leads')
          .update({ total_attempts: 0, disqualified: false, dnd: false, phone: phone })
          .eq('active_lead_id', activeLeadId);
      } else {
        const { data: activeLead, error: alErr } = await supabase
          .from('active_leads')
          .insert({ tenant_id: tenantId, campaign_id: campaignId, lead_id: leadId, phone: phone })
          .select('active_lead_id')
          .single();
        
        if (alErr) {
          console.error('[DB] Failed to insert active_lead:', alErr);
          throw alErr;
        }
        activeLeadId = activeLead.active_lead_id;
        allActiveLeadIds.push(activeLeadId);
      }

      // 3. Upsert into call_queue — ensure clean 'queued' row ready for dispatcher.
      if (activeLeadId) {
        let scheduledAt = nextAttemptAt;
        try {
          const onboardingConfig = await this.getOnboardingConfig(tenantId);
          const { isCallable, nextCallableSlot } = await import('../services/queueService.js');
          if (!scheduledAt) {
            scheduledAt = nextCallableSlot(onboardingConfig);
          } else if (!isCallable({ phone }, onboardingConfig, new Date(scheduledAt))) {
            scheduledAt = nextCallableSlot(onboardingConfig, new Date(scheduledAt));
          }
        } catch (_) {
          scheduledAt = nextAttemptAt || new Date().toISOString();
        }

        // Check if ANY row exists in call_queue across ALL active_lead_ids for this lead
        const { data: existingRows } = await supabase
          .from('call_queue')
          .select('queue_id, status, provisional_call_id, active_lead_id')
          .in('active_lead_id', allActiveLeadIds)
          .order('created_at', { ascending: false });

        if (existingRows && existingRows.length > 0) {
          const primaryRow = existingRows[0];
          // If any existing row held a provisional slot that was never released, release it
          for (const row of existingRows) {
            if (row.provisional_call_id && row.status === 'dispatched') {
              try {
                await supabase.rpc('fn_release_slot', { p_call_id: row.provisional_call_id });
              } catch (_) {}
            }
          }

          // Update primary row to queued with new scheduled time and canonical active_lead_id
          const { error: upErr } = await supabase
            .from('call_queue')
            .update({ 
              status: 'queued', 
              next_attempt_at: scheduledAt, 
              attempt_number: attemptNumber,
              provisional_call_id: null,
              phone: phone,
              campaign_id: campaignId,
              active_lead_id: activeLeadId,
              updated_at: new Date().toISOString()
            })
            .eq('queue_id', primaryRow.queue_id);
          if (upErr) console.error('[DB] Failed to update call_queue row:', upErr);

          // If duplicate/extra rows exist for this lead across all active_lead_ids, remove them
          if (existingRows.length > 1) {
            const duplicateIds = existingRows.slice(1).map(r => r.queue_id);
            await supabase
              .from('call_queue')
              .delete()
              .in('queue_id', duplicateIds);
          }
        } else {
          const { error: cqErr } = await supabase
            .from('call_queue')
            .insert({
              tenant_id: tenantId,
              campaign_id: campaignId,
              active_lead_id: activeLeadId,
              phone: phone,
              next_attempt_at: scheduledAt,
              attempt_number: attemptNumber,
              status: 'queued'
            });
          if (cqErr) {
            if (cqErr.code === '23505' && cqErr.message?.includes('call_queue_active_lead_uniq')) {
              console.warn(`[EnqueueGuard] Lead (phone ${phone}) already active in another campaign, skipping enqueue for campaign ${campaignId}`);
            } else {
              console.error('[DB] Failed to insert call_queue:', cqErr);
            }
          }
        }
      }

      return activeLeadId;
    } catch (err) {
      console.error('[DB] Error in enqueueToDialer:', err);
      return null;
    }
  },

  async updateLeadStatusAndData(id, status, rawData) {
    let oldStatus = 'unknown';
    let tenantId = null;
    try {
      const lead = await this.findLeadById(id);
      if (lead) {
        oldStatus = lead.status;
        tenantId = lead.tenant_id;
      }
    } catch (err) {
      console.error('Error finding lead for status update audit:', err);
    }

    let result;
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .update({ status, raw_data: rawData, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      result = data;
    } else {
      const lead = mockDb.leads.find(l => l.id === id);
      if (!lead) throw new Error('Lead not found');
      lead.status = status;
      lead.raw_data = rawData;
      lead.updated_at = new Date().toISOString();
      result = lead;
    }

    if (tenantId && oldStatus !== status) {
      try {
        let reason = `Status transitioned from ${oldStatus} to ${status}`;
        if (status === 're-queued') reason = `Call failed or busy. Re-queued for retry (Attempt: ${rawData.attempts || 1})`;
        
        await this.insertAuditLog(tenantId, 'disposition_changed', {
          lead_id: id,
          old_status: oldStatus,
          new_status: status,
          reason,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('Failed to insert disposition_changed audit log:', err);
      }
    }

    return result;
  },

  async getLeadInteractions(tenantId, leadId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('audit_trail')
        .select('*')
        .eq('tenant_id', tenantId)
        .filter('details->>lead_id', 'eq', leadId)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    } else {
      return mockDb.auditTrail
        .filter(a => a.tenant_id === tenantId && a.details && a.details.lead_id === leadId)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
  },

  async updateLeadCampaign(id, campaign_name) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .update({ campaign_name, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const lead = mockDb.leads.find(l => l.id === id);
      if (!lead) throw new Error('Lead not found');
      lead.campaign_name = campaign_name;
      lead.updated_at = new Date().toISOString();
      return lead;
    }
  },

  async updateLeadCampaignAndData(id, campaign_name, raw_data) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .update({ campaign_name, raw_data, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const lead = mockDb.leads.find(l => l.id === id);
      if (!lead) throw new Error('Lead not found');
      lead.campaign_name = campaign_name;
      lead.raw_data = raw_data;
      lead.updated_at = new Date().toISOString();
      return lead;
    }
  },

  async getAllLeadsByStatus(statuses) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .in('status', statuses);
      if (error) throw error;
      return data;
    } else {
      return mockDb.leads.filter(l => statuses.includes(l.status));
    }
  },

  async getActiveCallsCount(tenantId) {
    if (supabase) {
      const { count, error } = await supabase
        .from('leads')
        .select('*', { count: 'exact', head: true })
        .eq('tenant_id', tenantId)
        .eq('status', 'calling');
      if (error) throw error;
      return count || 0;
    } else {
      return mockDb.leads.filter(l => l.tenant_id === tenantId && l.status === 'calling').length;
    }
  },

  async getCallSessionsCount(leadId, campaignId) {
    if (supabase) {
      let query = supabase
        .from('call_sessions')
        .select('*', { count: 'exact', head: true })
        .eq('lead_id', leadId);
      
      if (campaignId) {
        query = query.eq('campaign_id', campaignId);
      } else {
        console.warn(`[db.getCallSessionsCount] Missing campaignId for lead ${leadId}. Falling back to total sessions.`);
      }

      const { count, error } = await query;
      if (error) throw error;
      return count || 0;
    } else {
      if (campaignId) {
        return mockDb.callSessions.filter(s => s.lead_id === leadId && s.campaign_id === campaignId).length;
      }
      console.warn(`[db.getCallSessionsCount] Missing campaignId for lead ${leadId} (MOCK). Falling back to total sessions.`);
      return mockDb.callSessions.filter(s => s.lead_id === leadId).length;
    }
  },
  async getLeads(tenantId, options = {}) {
    const limit = options.limit || 50000;
    const includeDeleted = options.includeDeleted === true;
    if (supabase) {
      const step = 1000;
      let from = 0;
      const allResults = [];
      while (allResults.length < limit) {
        const currentStep = Math.min(step, limit - allResults.length);
        let query = supabase
          .from('leads')
          .select('*')
          .eq('tenant_id', tenantId);

        if (!includeDeleted) {
          query = query.neq('status', 'deleted');
        }

        const { data, error } = await query
          .order('created_at', { ascending: false })
          .range(from, from + currentStep - 1);
        if (error) throw error;
        if (data && data.length > 0) {
          allResults.push(...data);
          from += data.length;
          if (data.length < currentStep) break;
        } else {
          break;
        }
      }
      return allResults;
    } else {
      return mockDb.leads
        .filter(l => l.tenant_id === tenantId && (includeDeleted || l.status !== 'deleted'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limit);
    }
  },

  async getOnboardingConfig(tenantId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('tenant_configs')
        .select('onboarding_config')
        .eq('tenant_id', tenantId)
        .single();
      if (error && error.code !== 'PGRST116') throw error;
      return data ? data.onboarding_config : {};
    } else {
      const config = mockDb.tenantConfigs[tenantId];
      return config ? config.onboarding_config || {} : {};
    }
  },

  async upsertOnboardingConfig(tenantId, config) {
    if (supabase) {
      const { error } = await supabase
        .from('tenant_configs')
        .upsert({
          tenant_id: tenantId,
          onboarding_config: config,
          updated_at: new Date().toISOString()
        }, { onConflict: 'tenant_id' });
      if (error) throw error;
    } else {
      if (!mockDb.tenantConfigs[tenantId]) {
        mockDb.tenantConfigs[tenantId] = {
          tenant_id: tenantId,
          scoring_weights: { ...DEFAULT_WEIGHTS },
          created_at: new Date().toISOString()
        };
      }
      mockDb.tenantConfigs[tenantId].onboarding_config = config;
      mockDb.tenantConfigs[tenantId].updated_at = new Date().toISOString();
    }
  },

  async insertAuditLog(tenantId, eventType, details = {}) {
    const logEntry = {
      id: uuidv4(),
      tenant_id: tenantId,
      event_type: eventType,
      details,
      created_at: new Date().toISOString()
    };
    if (supabase) {
      const { error } = await supabase
        .from('audit_trail')
        .insert(logEntry);
      if (error) console.error('Failed to write to audit_trail in Supabase:', error);
    } else {
      mockDb.auditTrail.push(logEntry);
    }
    return logEntry;
  },

  async getAuditTrail(tenantId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('audit_trail')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    } else {
      return mockDb.auditTrail
        .filter(l => l.tenant_id === tenantId)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
  },

  async insertCallSession(session) {
    const sessionVal = {
      id: session.id || uuidv4(),
      tenant_id: session.tenant_id,
      lead_id: session.lead_id,
      provider_session_id: session.provider_session_id || null,
      campaign_id: session.campaign_id || null,
      script_version: session.script_version || 'v1.0',
      started_at: session.started_at || new Date().toISOString(),
      ended_at: session.ended_at || null,
      disposition: session.disposition || 'queued',
      summary: session.summary || null,
      transcript_json: session.transcript_json || null,
      recording_url: session.recording_url || null,
      duration: session.duration || 0,
      sentiment: session.sentiment || null,
      analysis: session.analysis || null,
      outcome_score: session.outcome_score || null,
      created_at: new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase
        .from('call_sessions')
        .insert(sessionVal)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      mockDb.callSessions.push(sessionVal);
      return sessionVal;
    }
  },

  async updateCallSession(sessionId, updates) {
    if (supabase) {
      // Whitelist valid columns on call_sessions table
      const validCols = [
        'disposition',
        'summary',
        'ended_at',
        'started_at',
        'script_version',
        'provider_session_id',
        'lead_id',
        'tenant_id',
        'consent_status',
        'consent_captured_at',
        'campaign_id',
        'transcript_json',
        'recording_url',
        'duration',
        'sentiment',
        'analysis',
        'outcome_score'
      ];
      const filteredUpdates = {};
      const droppedKeys = [];
      for (const key of Object.keys(updates)) {
        if (validCols.includes(key)) {
          filteredUpdates[key] = updates[key];
        } else {
          droppedKeys.push(key);
        }
      }
      if (droppedKeys.length > 0) {
        console.warn(`[updateCallSession] Session ${sessionId} - dropped unknown keys: ${droppedKeys.join(', ')}`);
      }
      if (updates.ended_at !== undefined) {
        filteredUpdates.ended_at = updates.ended_at;
      } else if (updates.disposition && !['queued', 'calling', 'in-progress'].includes(updates.disposition)) {
        filteredUpdates.ended_at = new Date().toISOString();
      }

      const { data, error } = await supabase
        .from('call_sessions')
        .update(filteredUpdates)
        .eq('id', sessionId)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const session = mockDb.callSessions.find(s => s.id === sessionId);
      if (!session) throw new Error('Session not found');
      Object.assign(session, updates);
      if (updates.ended_at !== undefined) {
        session.ended_at = updates.ended_at;
      } else if (updates.disposition && !['queued', 'calling', 'in-progress'].includes(updates.disposition) && !session.ended_at) {
        session.ended_at = new Date().toISOString();
      }
      return session;
    }
  },

  async findCallSessionByProviderId(providerSessionId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('call_sessions')
        .select('*')
        .eq('provider_session_id', providerSessionId)
        .maybeSingle();
      if (error) throw error;
      return data;
    } else {
      return mockDb.callSessions.find(s => s.provider_session_id === providerSessionId) || null;
    }
  },

  async getCallSessions(tenantId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('call_sessions')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('started_at', { ascending: false });
      if (error) throw error;
      return data;
    } else {
      return mockDb.callSessions
        .filter(s => s.tenant_id === tenantId)
        .sort((a, b) => new Date(b.started_at) - new Date(a.started_at));
    }
  },

  async getCallSessionsByLeadId(leadId, tenantId = null) {
    if (supabase) {
      let query = supabase
        .from('call_sessions')
        .select('*')
        .eq('lead_id', leadId);
      if (tenantId) {
        query = query.eq('tenant_id', tenantId);
      }
      const { data, error } = await query.order('started_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } else {
      return mockDb.callSessions
        .filter(s => s.lead_id === leadId && (!tenantId || s.tenant_id === tenantId))
        .sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at));
    }
  },

  async getRecentCallSessions(tenantId, limit = 15) {
    if (supabase) {
      const { data, error } = await supabase
        .from('call_sessions')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('started_at', { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data || [];
    } else {
      return mockDb.callSessions
        .filter(s => s.tenant_id === tenantId)
        .sort((a, b) => new Date(b.started_at || b.created_at) - new Date(a.started_at || a.created_at))
        .slice(0, limit);
    }
  },

  async insertCallEvent(event) {
    const eventVal = {
      id: event.id || uuidv4(),
      tenant_id: event.tenant_id,
      session_id: event.session_id,
      event_type: event.event_type,
      payload: event.payload || {},
      timestamp: event.timestamp || new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase
        .from('call_events')
        .insert(eventVal)
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      mockDb.callEvents.push(eventVal);
      return eventVal;
    }
  },

  async getCallEvents(tenantId, eventType = null) {
    if (supabase) {
      let query = supabase
        .from('call_events')
        .select('*')
        .eq('tenant_id', tenantId);
      
      if (eventType) {
        query = query.eq('event_type', eventType);
      }
      
      const { data, error } = await query.order('timestamp', { ascending: false });
      if (error) throw error;
      return data;
    } else {
      let events = mockDb.callEvents.filter(e => e.tenant_id === tenantId);
      if (eventType) {
        events = events.filter(e => e.event_type === eventType);
      }
      return events.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    }
  },

  async addDncNumber(tenantId, phone) {
    const cleaned = phone.replace(/[^0-9+]/g, '');
    if (supabase) {
      const { data, error } = await supabase
        .from('dnc_registry')
        .upsert({ tenant_id: tenantId, phone: cleaned }, { onConflict: 'tenant_id,phone' })
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      const exists = mockDb.dncRegistry.some(d => d.tenant_id === tenantId && d.phone === cleaned);
      if (!exists) {
        mockDb.dncRegistry.push({
          id: uuidv4(),
          tenant_id: tenantId,
          phone: cleaned,
          created_at: new Date().toISOString()
        });
      }
      return { tenant_id: tenantId, phone: cleaned };
    }
  },

  async isDncNumber(tenantId, phone) {
    const cleaned = phone.replace(/[^0-9+]/g, '');
    if (supabase) {
      const { data, error } = await supabase
        .from('dnc_registry')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('phone', cleaned)
        .maybeSingle();
      if (error) throw error;
      return !!data;
    } else {
      return mockDb.dncRegistry.some(d => d.tenant_id === tenantId && d.phone === cleaned);
    }
  },

  async getDncNumbersBatch(tenantId, phones) {
    if (!phones || phones.length === 0) return new Set();
    const cleanedList = phones.map(p => p.replace(/[^0-9+]/g, ''));
    if (supabase) {
      const CHUNK = 1000;
      const dncSet = new Set();
      for (let i = 0; i < cleanedList.length; i += CHUNK) {
        const slice = cleanedList.slice(i, i + CHUNK);
        const { data, error } = await supabase
          .from('dnc_registry')
          .select('phone')
          .eq('tenant_id', tenantId)
          .in('phone', slice);
        if (error) throw error;
        if (data) {
          data.forEach(d => dncSet.add(d.phone));
        }
      }
      return dncSet;
    } else {
      const cleanedSet = new Set(cleanedList);
      const found = mockDb.dncRegistry
        .filter(d => d.tenant_id === tenantId && cleanedSet.has(d.phone))
        .map(d => d.phone);
      return new Set(found);
    }
  },

  async getDncList(tenantId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('dnc_registry')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    } else {
      return mockDb.dncRegistry.filter(d => d.tenant_id === tenantId);
    }
  },

  async removeDncNumber(tenantId, phone) {
    const cleaned = phone.replace(/[^0-9+]/g, '');
    if (supabase) {
      const { error } = await supabase
        .from('dnc_registry')
        .delete()
        .eq('tenant_id', tenantId)
        .eq('phone', cleaned);
      if (error) throw error;
      return true;
    } else {
      mockDb.dncRegistry = mockDb.dncRegistry.filter(d => !(d.tenant_id === tenantId && d.phone === cleaned));
      return true;
    }
  },

  async getLeadsByStatus(tenantId, statuses) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('tenant_id', tenantId)
        .in('status', statuses)
        .order('score', { ascending: false });
      if (error) throw error;
      return data;
    } else {
      return mockDb.leads
        .filter(l => l.tenant_id === tenantId && statuses.includes(l.status))
        .sort((a, b) => b.score - a.score);
    }
  },

  async insertScript(script) {
    const scriptVal = {
      id: script.id || uuidv4(),
      tenant_id: script.tenant_id,
      script_id: script.script_id,
      version: script.version || '1.0',
      language: script.language || 'en',
      nodes: script.nodes || [],
      escalation_triggers: script.escalation_triggers || [],
      max_duration_seconds: script.max_duration_seconds || 300,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase
        .from('scripts')
        .insert(scriptVal)
        .select()
        .single();
      if (error) {
        if (error.code === '23505' || error.message?.includes('duplicate key value violates unique constraint')) {
          const err = new Error('Duplicate script version found');
          err.code = '23505';
          throw err;
        }
        throw error;
      }
      return data;
    } else {
      const exists = mockDb.scripts.some(
        s => s.tenant_id === scriptVal.tenant_id && s.script_id === scriptVal.script_id && s.version === scriptVal.version
      );
      if (exists) {
        const err = new Error('Duplicate script version found');
        err.code = '23505';
        throw err;
      }
      mockDb.scripts.push(scriptVal);
      return scriptVal;
    }
  },

  async getScript(tenantId, scriptId, version) {
    if (supabase) {
      const { data, error } = await supabase
        .from('scripts')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('script_id', scriptId)
        .eq('version', version)
        .maybeSingle();
      if (error) throw error;
      return data;
    } else {
      return mockDb.scripts.find(
        s => s.tenant_id === tenantId && s.script_id === scriptId && s.version === version
      ) || null;
    }
  },

  async getLatestScript(tenantId, scriptId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('scripts')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('script_id', scriptId)
        .order('version', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    } else {
      const tenantScripts = mockDb.scripts.filter(s => s.tenant_id === tenantId && s.script_id === scriptId);
      if (tenantScripts.length === 0) return null;
      tenantScripts.sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }));
      return tenantScripts[0];
    }
  },

  async getAllScripts(tenantId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('scripts')
        .select('*')
        .eq('tenant_id', tenantId)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data;
    } else {
      return mockDb.scripts
        .filter(s => s.tenant_id === tenantId)
        .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }
  },

  async upsertAgentBrief(tenantId, leadId, brief) {
    const briefVal = {
      tenant_id: tenantId,
      lead_id: leadId,
      brief: brief || {},
      updated_at: new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase
        .from('agent_briefs')
        .upsert(briefVal, { onConflict: 'lead_id' })
        .select()
        .single();
      if (error) throw error;
      return data;
    } else {
      let existing = mockDb.agentBriefs.find(b => b.lead_id === leadId);
      if (existing) {
        existing.brief = brief;
        existing.updated_at = new Date().toISOString();
        return existing;
      } else {
        const newBrief = {
          id: uuidv4(),
          ...briefVal,
          created_at: new Date().toISOString()
        };
        mockDb.agentBriefs.push(newBrief);
        return newBrief;
      }
    }
  },

  async getAgentBrief(leadId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('agent_briefs')
        .select('*')
        .eq('lead_id', leadId)
        .maybeSingle();
      if (error) throw error;
      return data;
    } else {
      return mockDb.agentBriefs.find(b => b.lead_id === leadId) || null;
    }
  },

  async deleteCampaign(tenantId, campaignIdentifier, options = {}) {
    const isSoftDelete = options.softDelete === true;
    const now = new Date().toISOString();
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(campaignIdentifier).trim());

    if (supabase) {
      // 1. Resolve campaign record by ID or Name
      let campaignRecord = null;
      if (isUuid) {
        const { data } = await supabase
          .from('campaigns')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('id', campaignIdentifier)
          .maybeSingle();
        campaignRecord = data;
      }
      if (!campaignRecord) {
        const { data } = await supabase
          .from('campaigns')
          .select('*')
          .eq('tenant_id', tenantId)
          .ilike('name', String(campaignIdentifier).trim())
          .maybeSingle();
        campaignRecord = data;
      }

      const campaignId = campaignRecord?.id || (isUuid ? campaignIdentifier : null);
      const campaignName = campaignRecord?.name || String(campaignIdentifier).trim();
      const normTargetName = campaignName.toLowerCase();

      // 2. Fetch all lead IDs associated via junction table (lead_campaigns)
      const junctionLeadIds = new Set();
      if (campaignId) {
        let jFrom = 0;
        const jStep = 1000;
        while (true) {
          const { data: jData, error: jErr } = await supabase
            .from('lead_campaigns')
            .select('lead_id')
            .eq('tenant_id', tenantId)
            .eq('campaign_id', campaignId)
            .range(jFrom, jFrom + jStep - 1);
          if (jErr) break;
          if (jData && jData.length > 0) {
            jData.forEach(r => junctionLeadIds.add(r.lead_id));
            jFrom += jData.length;
            if (jData.length < jStep) break;
          } else {
            break;
          }
        }
      }

      // 3. Scan all leads for this tenant with range pagination (1000/chunk) to handle 10k+ leads
      let lFrom = 0;
      const lStep = 1000;
      const allLeads = [];
      while (true) {
        const { data: lData, error: fetchErr } = await supabase
          .from('leads')
          .select('id, campaign_name, raw_data, status')
          .eq('tenant_id', tenantId)
          .range(lFrom, lFrom + lStep - 1);
        if (fetchErr) throw fetchErr;
        if (lData && lData.length > 0) {
          allLeads.push(...lData);
          lFrom += lData.length;
          if (lData.length < lStep) break;
        } else {
          break;
        }
      }

      // 4. Categorize leads: either only this campaign (delete/soft-delete) or multi-campaign (update campaign_name)
      const leadsToDelete = [];
      const leadsToUpdate = [];

      allLeads.forEach(lead => {
        const campaigns = lead.campaign_name
          ? lead.campaign_name.split(',').map(c => c.trim()).filter(Boolean)
          : [];

        const isJunctionMatch = junctionLeadIds.has(lead.id);
        const isNameMatch = campaigns.some(c => c.toLowerCase() === normTargetName);
        const isRawMatch = lead.raw_data && (
          lead.raw_data.campaign_id === campaignId ||
          (lead.raw_data.campaign_name && lead.raw_data.campaign_name.toLowerCase() === normTargetName)
        );

        if (isJunctionMatch || isNameMatch || isRawMatch) {
          const remainingCampaigns = campaigns.filter(c => c.toLowerCase() !== normTargetName);
          if (remainingCampaigns.length === 0) {
            leadsToDelete.push(lead.id);
          } else {
            leadsToUpdate.push({ id: lead.id, campaign_name: remainingCampaigns.join(', ') });
          }
        }
      });

      // 5. Delete or Soft-Delete leads in safe batches of 100 IDs to prevent HTTP 414 URI Too Large errors
      const BATCH_SIZE = 100;
      if (leadsToDelete.length > 0) {
        for (let i = 0; i < leadsToDelete.length; i += BATCH_SIZE) {
          const chunk = leadsToDelete.slice(i, i + BATCH_SIZE);

          // Clean up junction rows
          try {
            await supabase.from('lead_campaigns').delete().in('lead_id', chunk);
          } catch (e) {
            console.warn('[db.deleteCampaign] Junction cleanup non-fatal warning:', e.message);
          }

          // Clean up child tables
          try {
            await supabase.from('agent_briefs').delete().in('lead_id', chunk);
            await supabase.from('call_events').delete().in('lead_id', chunk);
            await supabase.from('call_sessions').delete().in('lead_id', chunk);
          } catch (e) {
            console.warn('[db.deleteCampaign] Child tables cleanup non-fatal warning:', e.message);
          }

          if (isSoftDelete) {
            const { error: updErr } = await supabase
              .from('leads')
              .update({ status: 'deleted', updated_at: now })
              .in('id', chunk);
            if (updErr) throw updErr;
          } else {
            const { error: deleteErr } = await supabase
              .from('leads')
              .delete()
              .in('id', chunk);

            if (deleteErr) {
              // Fallback to soft-delete if foreign key constraints prevent row deletion
              console.warn('[db.deleteCampaign] Physical delete fallback to soft-delete:', deleteErr.message);
              await supabase
                .from('leads')
                .update({ status: 'deleted', updated_at: now })
                .in('id', chunk);
            }
          }
        }
      }

      // 6. Update leads belonging to other campaigns
      for (const leadUpdate of leadsToUpdate) {
        await supabase
          .from('leads')
          .update({ campaign_name: leadUpdate.campaign_name, updated_at: now })
          .eq('id', leadUpdate.id);
      }

      // 7. Update or delete junction entries for this campaign
      if (campaignId) {
        try {
          await supabase
            .from('lead_campaigns')
            .update({ removed_at: now })
            .eq('campaign_id', campaignId);
          if (!isSoftDelete) {
            await supabase
              .from('lead_campaigns')
              .delete()
              .eq('campaign_id', campaignId);
          }
        } catch (e) {
          console.warn('[db.deleteCampaign] Junction campaign cleanup non-fatal:', e.message);
        }
      }

      // 8. Delete or Soft-Delete the campaign record
      if (campaignId) {
        if (isSoftDelete) {
          await supabase
            .from('campaigns')
            .update({ status: 'deleted', updated_at: now })
            .eq('tenant_id', tenantId)
            .eq('id', campaignId);
        } else {
          const { error: campDeleteErr } = await supabase
            .from('campaigns')
            .delete()
            .eq('tenant_id', tenantId)
            .eq('id', campaignId);

          if (campDeleteErr) {
            // Fallback to soft-delete
            await supabase
              .from('campaigns')
              .update({ status: 'deleted', updated_at: now })
              .eq('tenant_id', tenantId)
              .eq('id', campaignId);
          }
        }
      } else {
        if (isSoftDelete) {
          await supabase
            .from('campaigns')
            .update({ status: 'deleted', updated_at: now })
            .eq('tenant_id', tenantId)
            .ilike('name', campaignName);
        } else {
          await supabase
            .from('campaigns')
            .delete()
            .eq('tenant_id', tenantId)
            .ilike('name', campaignName);
        }
      }

      return {
        success: true,
        campaignId,
        campaignName,
        deletedCount: leadsToDelete.length,
        updatedCount: leadsToUpdate.length,
        softDeleted: isSoftDelete
      };

    } else {
      // Mock DB implementation
      const rawIdentifierStr = String(campaignIdentifier).trim();
      const rawLower = rawIdentifierStr.toLowerCase();

      const campaign = mockDb.campaigns.find(c =>
        c.tenant_id === tenantId &&
        (c.id === campaignIdentifier || c.name.toLowerCase() === rawLower)
      );

      const campaignId = campaign?.id || (isUuid ? campaignIdentifier : null);
      const campaignName = campaign?.name || rawIdentifierStr;
      const normTargetName = campaignName.toLowerCase();

      mockDb.leadCampaigns = mockDb.leadCampaigns || [];
      const junctionLeadIds = new Set(
        mockDb.leadCampaigns
          .filter(lc => lc.tenant_id === tenantId && lc.campaign_id === campaignId)
          .map(lc => lc.lead_id)
      );

      const leadsToDelete = [];
      const leadsToUpdate = [];

      mockDb.leads.forEach(lead => {
        if (lead.tenant_id === tenantId) {
          const campaigns = lead.campaign_name
            ? lead.campaign_name.split(',').map(c => c.trim()).filter(Boolean)
            : [];

          const isJunctionMatch = junctionLeadIds.has(lead.id);
          const isNameMatch = campaigns.some(c => c.toLowerCase() === normTargetName);
          const isRawMatch = lead.raw_data && (
            lead.raw_data.campaign_id === campaignId ||
            (lead.raw_data.campaign_name && lead.raw_data.campaign_name.toLowerCase() === normTargetName)
          );

          if (isJunctionMatch || isNameMatch || isRawMatch) {
            const remaining = campaigns.filter(c => c.toLowerCase() !== normTargetName);
            if (remaining.length === 0) {
              leadsToDelete.push(lead.id);
            } else {
              leadsToUpdate.push({ id: lead.id, campaign_name: remaining.join(', ') });
            }
          }
        }
      });

      if (leadsToDelete.length > 0) {
        if (isSoftDelete) {
          mockDb.leads.forEach(l => {
            if (leadsToDelete.includes(l.id)) {
              l.status = 'deleted';
              l.updated_at = now;
            }
          });
        } else {
          mockDb.leads = mockDb.leads.filter(l => !leadsToDelete.includes(l.id));
          mockDb.agentBriefs = mockDb.agentBriefs.filter(b => !leadsToDelete.includes(b.lead_id));
          const sessionIds = mockDb.callSessions.filter(s => leadsToDelete.includes(s.lead_id)).map(s => s.id);
          mockDb.callSessions = mockDb.callSessions.filter(s => !leadsToDelete.includes(s.lead_id));
          mockDb.callEvents = mockDb.callEvents.filter(e => !sessionIds.includes(e.session_id) && !leadsToDelete.includes(e.lead_id));
        }
      }

      leadsToUpdate.forEach(u => {
        const lead = mockDb.leads.find(l => l.id === u.id);
        if (lead) {
          lead.campaign_name = u.campaign_name;
          lead.updated_at = now;
        }
      });

      // Update junction
      if (campaignId) {
        if (isSoftDelete) {
          mockDb.leadCampaigns.forEach(lc => {
            if (lc.campaign_id === campaignId && lc.tenant_id === tenantId) {
              lc.removed_at = now;
            }
          });
        } else {
          mockDb.leadCampaigns = mockDb.leadCampaigns.filter(lc => !(lc.campaign_id === campaignId && lc.tenant_id === tenantId));
        }
      }

      // Campaign record
      if (campaign) {
        if (isSoftDelete) {
          campaign.status = 'deleted';
          campaign.updated_at = now;
        } else {
          mockDb.campaigns = mockDb.campaigns.filter(c => c.id !== campaign.id);
        }
      } else {
        if (isSoftDelete) {
          mockDb.campaigns.forEach(c => {
            if (c.tenant_id === tenantId && c.name.toLowerCase() === normTargetName) {
              c.status = 'deleted';
              c.updated_at = now;
            }
          });
        } else {
          mockDb.campaigns = mockDb.campaigns.filter(c => !(c.tenant_id === tenantId && c.name.toLowerCase() === normTargetName));
        }
      }

      return {
        success: true,
        campaignId,
        campaignName,
        deletedCount: leadsToDelete.length,
        updatedCount: leadsToUpdate.length,
        softDeleted: isSoftDelete
      };
    }
  },

  async insertJob(tenant_id, type, payload) {
    const job = {
      id: uuidv4(),
      tenant_id,
      job_type: type,
      status: 'pending',
      payload,
      result: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase.from('background_jobs').insert([job]).select().single();
      if (error) {
        if (error.code === '42P01') {
           // relation does not exist, use mock as fallback
           console.warn('background_jobs table not found in Supabase. Falling back to mock jobs.');
           mockDb.jobs.push(job);
           return job;
        }
        throw error;
      }
      return data;
    } else {
      mockDb.jobs.push(job);
      return job;
    }
  },

  async fetchNextPendingJob() {
    if (supabase) {
      // Auto-recover stale jobs stuck in 'processing' for more than 15 minutes
      try {
        const staleThreshold = new Date(Date.now() - 15 * 60 * 1000).toISOString();
        await supabase
          .from('background_jobs')
          .update({
            status: 'failed',
            result: { error: 'Job timed out in processing state (auto-recovered)' },
            updated_at: new Date().toISOString()
          })
          .eq('status', 'processing')
          .lt('updated_at', staleThreshold);
      } catch (recoveryErr) {
        // Non-blocking recovery attempt
      }

      // Find oldest pending job ONLY
      const { data, error } = await supabase
        .from('background_jobs')
        .select('*')
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();
      
      if (error) {
        if (error.code === 'PGRST116') return null; // No rows found
        if (error.code === '42P01') {
           // Fallback to mock
           const job = mockDb.jobs.find(j => j.status === 'pending');
           return job || null;
        }
        console.error('Error fetching next pending job:', error);
        return null;
      }
      return data || null;
    } else {
      const job = mockDb.jobs.find(j => j.status === 'pending');
      return job || null;
    }
  },

  async updateJobStatus(job_id, status, result = null) {
    const updateData = {
      status,
      result,
      updated_at: new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase
        .from('background_jobs')
        .update(updateData)
        .eq('id', job_id)
        .select()
        .single();
      
      if (error) {
         if (error.code === '42P01') {
            const index = mockDb.jobs.findIndex(j => j.id === job_id);
            if (index !== -1) {
              mockDb.jobs[index] = { ...mockDb.jobs[index], ...updateData };
              return mockDb.jobs[index];
            }
         }
         console.error('Error updating job status:', error);
         return null;
      }
      return data;
    } else {
      const index = mockDb.jobs.findIndex(j => j.id === job_id);
      if (index !== -1) {
        mockDb.jobs[index] = { ...mockDb.jobs[index], ...updateData };
        return mockDb.jobs[index];
      }
      return null;
    }
  },

  async insertCampaign(campaignData) {
    const campaignVal = {
      id: campaignData.id || uuidv4(),
      tenant_id: campaignData.tenant_id,
      name: campaignData.name || 'Untitled Campaign',
      status: campaignData.status || 'draft',
      total_leads: campaignData.total_leads || 0,
      processed_leads: campaignData.processed_leads || 0,
      failed_leads: campaignData.failed_leads || 0,
      scheduled_at: campaignData.scheduled_at || null,
      started_at: campaignData.started_at || null,
      finished_at: campaignData.finished_at || null,
      job_id: campaignData.job_id || null,
      whatsapp_threshold: campaignData.whatsapp_threshold !== undefined ? campaignData.whatsapp_threshold : 70,
      max_concurrency: campaignData.max_concurrency !== undefined ? campaignData.max_concurrency : 3,
      voice_agent_id: campaignData.voice_agent_id || null,
      voice_provider: campaignData.voice_provider || 'gnani',
      launch_strategy: campaignData.launch_strategy || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase
        .from('campaigns')
        .insert(campaignVal)
        .select()
        .single();
      if (error && error.code !== '42P01') throw error;
      if (error && error.code === '42P01') {
         mockDb.campaigns.push(campaignVal);
         return campaignVal;
      }
      return data;
    } else {
      mockDb.campaigns.push(campaignVal);
      return campaignVal;
    }
  },

  async updateCampaign(campaignId, updateData) {
    updateData.updated_at = new Date().toISOString();
    if (supabase) {
      const { data, error } = await supabase
        .from('campaigns')
        .update(updateData)
        .eq('id', campaignId)
        .select()
        .single();
      if (error && error.code !== '42P01') throw error;
      if (error && error.code === '42P01') {
         const index = mockDb.campaigns.findIndex(c => c.id === campaignId);
         if (index !== -1) {
           mockDb.campaigns[index] = { ...mockDb.campaigns[index], ...updateData };
           return mockDb.campaigns[index];
         }
         return null;
      }
      return data;
    } else {
      const index = mockDb.campaigns.findIndex(c => c.id === campaignId);
      if (index !== -1) {
        mockDb.campaigns[index] = { ...mockDb.campaigns[index], ...updateData };
        return mockDb.campaigns[index];
      }
      return null;
    }
  },

  async getCampaign(campaignId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('campaigns')
        .select('*')
        .eq('id', campaignId)
        .maybeSingle();
      if (error && error.code !== '42P01') throw error;
      if (error && error.code === '42P01') return mockDb.campaigns.find(c => c.id === campaignId) || null;
      return data;
    } else {
      return mockDb.campaigns.find(c => c.id === campaignId) || null;
    }
  },

  async getCampaigns(tenantId, options = {}) {
    const includeDeleted = options.includeDeleted === true;
    if (supabase) {
      let query = supabase
        .from('campaigns')
        .select('*')
        .eq('tenant_id', tenantId);

      if (!includeDeleted) {
        query = query.neq('status', 'deleted');
      }

      const { data, error } = await query
        .order('created_at', { ascending: false });
      if (error && error.code !== '42P01') throw error;
      if (error && error.code === '42P01') {
        return mockDb.campaigns
          .filter(c => c.tenant_id === tenantId && (includeDeleted || c.status !== 'deleted'))
          .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      }
      return data;
    } else {
      return mockDb.campaigns
        .filter(c => c.tenant_id === tenantId && (includeDeleted || c.status !== 'deleted'))
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
  },

    async getCampaignDraft(tenantId) {
    const isMissingTable = (err) => err && (err.code === '42P01' || err.code === 'PGRST204' || err.code === 'PGRST205' || err.message?.includes('schema cache') || err.message?.includes('Could not find the table'));
    const tId = String(tenantId).trim();

    const formatDraftResult = (data) => {
      if (!data) return null;
      const formObj = data.form_data && typeof data.form_data === 'object' ? data.form_data : {};
      return {
        ...formObj,
        id: data.id,
        tenant_id: data.tenant_id,
        step: data.step || formObj.step || 1,
        campaign_name: data.campaign_name || formObj.campaign_name || 'Untitled Draft',
        saved_at: formObj.saved_at || data.updated_at,
        created_at: data.created_at,
        updated_at: data.updated_at,
        form_data: formObj
      };
    };

    if (supabase) {
      const { data, error } = await supabase
        .from('campaign_drafts')
        .select('*')
        .eq('tenant_id', tId)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error && !isMissingTable(error)) throw error;
      if (error && isMissingTable(error)) {
        const found = (mockDb.campaignDrafts || []).find(d => d.tenant_id === tId) || null;
        return formatDraftResult(found);
      }
      return formatDraftResult(data);
    } else {
      if (!mockDb.campaignDrafts) mockDb.campaignDrafts = [];
      const found = mockDb.campaignDrafts.find(d => d.tenant_id === tId) || null;
      return formatDraftResult(found);
    }
  },

  async upsertCampaignDraft(tenantId, draftData) {
    const isMissingTable = (err) => err && (err.code === '42P01' || err.code === 'PGRST204' || err.code === 'PGRST205' || err.message?.includes('schema cache') || err.message?.includes('Could not find the table'));
    const tId = String(tenantId).trim();

    const formPayload = draftData.form_data && typeof draftData.form_data === 'object' ? draftData.form_data : draftData;
    const campNameCandidate = (draftData.campaign_name || formPayload.campaign_name || draftData.name || 'Untitled Draft').trim();

    // Guard: If this campaign has already been completed/launched, never resurrect it as an in-progress draft
    try {
      if (campNameCandidate && campNameCandidate.toLowerCase() !== 'untitled draft') {
        const existingCamps = await this.getCampaigns(tId);
        const alreadyExists = (existingCamps || []).some(c => 
          c.name && c.name.trim().toLowerCase() === campNameCandidate.toLowerCase() && c.status !== 'deleted'
        );
        if (alreadyExists) {
          return null;
        }
      }
    } catch (e) {
      // Non-blocking fallback
    }

    const draftVal = {
      id: draftData.id || uuidv4(),
      tenant_id: tId,
      step: draftData.step || formPayload.step || 1,
      campaign_name: campNameCandidate,
      form_data: formPayload,
      created_at: draftData.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const formatDraftResult = (data) => {
      if (!data) return null;
      const formObj = data.form_data && typeof data.form_data === 'object' ? data.form_data : {};
      return {
        ...formObj,
        id: data.id,
        tenant_id: data.tenant_id,
        step: data.step || formObj.step || 1,
        campaign_name: data.campaign_name || formObj.campaign_name || 'Untitled Draft',
        saved_at: formObj.saved_at || data.updated_at,
        created_at: data.created_at,
        updated_at: data.updated_at,
        form_data: formObj
      };
    };

    if (supabase) {
      const { data, error } = await supabase
        .from('campaign_drafts')
        .upsert(draftVal, { onConflict: 'tenant_id' })
        .select()
        .single();
      if (error && !isMissingTable(error)) throw error;
      if (error && isMissingTable(error)) {
        if (!mockDb.campaignDrafts) mockDb.campaignDrafts = [];
        const idx = mockDb.campaignDrafts.findIndex(d => d.tenant_id === tId);
        if (idx !== -1) {
          mockDb.campaignDrafts[idx] = { ...mockDb.campaignDrafts[idx], ...draftVal };
          return formatDraftResult(mockDb.campaignDrafts[idx]);
        } else {
          mockDb.campaignDrafts.push(draftVal);
          return formatDraftResult(draftVal);
        }
      }
      return formatDraftResult(data);
    } else {
      if (!mockDb.campaignDrafts) mockDb.campaignDrafts = [];
      const idx = mockDb.campaignDrafts.findIndex(d => d.tenant_id === tId);
      if (idx !== -1) {
        mockDb.campaignDrafts[idx] = { ...mockDb.campaignDrafts[idx], ...draftVal };
        return formatDraftResult(mockDb.campaignDrafts[idx]);
      } else {
        mockDb.campaignDrafts.push(draftVal);
        return formatDraftResult(draftVal);
      }
    }
  },

  async deleteCampaignDraft(tenantId) {
    const isMissingTable = (err) => err && (err.code === '42P01' || err.code === 'PGRST204' || err.code === 'PGRST205' || err.message?.includes('schema cache') || err.message?.includes('Could not find the table'));
    const tId = String(tenantId).trim();

    if (supabase) {
      const { error } = await supabase
        .from('campaign_drafts')
        .delete()
        .eq('tenant_id', tId);
      if (error && !isMissingTable(error)) throw error;
    }
    if (!mockDb.campaignDrafts) mockDb.campaignDrafts = [];
    const idx = mockDb.campaignDrafts.findIndex(d => d.tenant_id === tId);
    if (idx !== -1) {
      mockDb.campaignDrafts.splice(idx, 1);
      return { success: true, deleted: true };
    }
    return { success: true, deleted: true };
  },

  async getTotalProcessedLeads() {
    if (supabase) {
      const { data, error } = await supabase
        .from('campaigns')
        .select('processed_leads');
      if (error && error.code !== '42P01') throw error;
      if (error && error.code === '42P01') {
        return mockDb.campaigns.reduce((sum, c) => sum + (c.processed_leads || 0), 0);
      }
      if (data) {
        return data.reduce((sum, c) => sum + (c.processed_leads || 0), 0);
      }
      return 0;
    } else {
      return mockDb.campaigns.reduce((sum, c) => sum + (c.processed_leads || 0), 0);
    }
  },


  async addLeadToCampaign(tenantId, leadId, campaignId) {
    if (supabase) {
      const { error } = await supabase
        .from('lead_campaigns')
        .upsert({ tenant_id: tenantId, lead_id: leadId, campaign_id: campaignId }, { onConflict: 'lead_id, campaign_id', ignoreDuplicates: true });
      if (error && error.code !== '23505') throw error;
    } else {
      mockDb.leadCampaigns = mockDb.leadCampaigns || [];
      const exists = mockDb.leadCampaigns.find(lc => lc.lead_id === leadId && lc.campaign_id === campaignId);
      if (!exists) {
        mockDb.leadCampaigns.push({
          id: uuidv4(),
          tenant_id: tenantId,
          lead_id: leadId,
          campaign_id: campaignId,
          added_at: new Date().toISOString(),
          removed_at: null
        });
      }
    }
  },

  async addLeadsToCampaign(tenantId, leadIds, campaignId) {
    if (!leadIds || leadIds.length === 0) return;
    const now = new Date().toISOString();
    const records = leadIds.map(leadId => ({
      tenant_id: tenantId,
      lead_id: leadId,
      campaign_id: campaignId,
      added_at: now
    }));

    if (supabase) {
      const CHUNK = 1000;
      for (let i = 0; i < records.length; i += CHUNK) {
        const slice = records.slice(i, i + CHUNK);
        const { error } = await supabase
          .from('lead_campaigns')
          .upsert(slice, { onConflict: 'lead_id,campaign_id', ignoreDuplicates: true });
        if (error && error.code !== '23505') throw error;
      }
    } else {
      mockDb.leadCampaigns = mockDb.leadCampaigns || [];
      for (const rec of records) {
        const exists = mockDb.leadCampaigns.find(lc => lc.lead_id === rec.lead_id && lc.campaign_id === rec.campaign_id);
        if (!exists) {
          mockDb.leadCampaigns.push({
            id: uuidv4(),
            ...rec,
            removed_at: null
          });
        }
      }
    }
  },

  async removeLeadFromCampaign(tenantId, leadId, campaignId) {
    if (supabase) {
      const { error } = await supabase
        .from('lead_campaigns')
        .update({ removed_at: new Date().toISOString() })
        .eq('tenant_id', tenantId)
        .eq('lead_id', leadId)
        .eq('campaign_id', campaignId);
      if (error) throw error;
    } else {
      mockDb.leadCampaigns = mockDb.leadCampaigns || [];
      const lc = mockDb.leadCampaigns.find(l => l.lead_id === leadId && l.campaign_id === campaignId && l.tenant_id === tenantId);
      if (lc) lc.removed_at = new Date().toISOString();
    }
  },

  async getLeadsForCampaign(tenantId, campaignId, options = {}) {
    const limit = options.limit || 50000;
    if (supabase) {
      const step = 1000;
      let from = 0;
      const allResults = [];
      while (allResults.length < limit) {
        const currentStep = Math.min(step, limit - allResults.length);
        const { data, error } = await supabase
          .from('leads')
          .select('*, lead_campaigns!inner(campaign_id, removed_at)')
          .eq('tenant_id', tenantId)
          .eq('lead_campaigns.campaign_id', campaignId)
          .is('lead_campaigns.removed_at', null)
          .range(from, from + currentStep - 1);
        if (error) throw error;
        if (data && data.length > 0) {
          allResults.push(...data);
          from += data.length;
          if (data.length < currentStep) break;
        } else {
          break;
        }
      }

      // Also ensure any ingested leads with campaign_name matching this campaign are included
      try {
        const { data: camp } = await supabase.from('campaigns').select('name').eq('id', campaignId).maybeSingle();
        if (camp && camp.name && allResults.length < limit) {
          const existingIds = new Set(allResults.map(r => r.id));
          const { data: nameMatched } = await supabase
            .from('leads')
            .select('*')
            .eq('tenant_id', tenantId)
            .ilike('campaign_name', `%${camp.name}%`)
            .limit(limit - allResults.length);
          if (nameMatched && nameMatched.length > 0) {
            const unlinked = nameMatched.filter(l => !existingIds.has(l.id));
            if (unlinked.length > 0) {
              allResults.push(...unlinked);
              const junctionRows = unlinked.map(l => ({
                tenant_id: tenantId,
                campaign_id: campaignId,
                lead_id: l.id
              }));
              supabase.from('lead_campaigns')
                .upsert(junctionRows, { onConflict: 'lead_id,campaign_id', ignoreDuplicates: true })
                .then(() => {})
                .catch(() => {});
            }
          }
        }
      } catch (matchErr) {
        console.warn('[DB] Fallback campaign_name lookup error:', matchErr?.message || matchErr);
      }

      return allResults;
    } else {
      mockDb.leadCampaigns = mockDb.leadCampaigns || [];
      const activeLeadIds = mockDb.leadCampaigns
        .filter(lc => lc.tenant_id === tenantId && lc.campaign_id === campaignId && !lc.removed_at)
        .map(lc => lc.lead_id);
      
      return mockDb.leads.filter(l => {
        if (l.tenant_id !== tenantId) return false;
        if (activeLeadIds.includes(l.id)) return true;
        // Fallback for mock tests
        const campaign = mockDb.campaigns.find(c => c.id === campaignId);
        if (!campaign || !l.campaign_name) return false;
        const list = l.campaign_name.split(',').map(c => c.trim().toLowerCase());
        return list.includes(campaign.name.toLowerCase());
      }).slice(0, limit);
    }
  },

  async insertLeadIngestionError(errorData) {
    const errorVal = {
      id: uuidv4(),
      campaign_id: errorData.campaign_id,
      tenant_id: errorData.tenant_id,
      raw_data: errorData.raw_data || {},
      error_reason: errorData.error_reason || 'Unknown error',
      created_at: new Date().toISOString()
    };
    if (supabase) {
      const { data, error } = await supabase
        .from('lead_ingestion_errors')
        .insert(errorVal)
        .select()
        .single();
      if (error && error.code !== '42P01') console.error('Error inserting lead error:', error);
      if (error && error.code === '42P01') mockDb.leadIngestionErrors.push(errorVal);
      return data || errorVal;
    } else {
      mockDb.leadIngestionErrors.push(errorVal);
      return errorVal;
    }
  },

  async getUnassignedLeads(tenantId) {
    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('status', 'ingested')
        .is('campaign_name', null)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    } else {
      return mockDb.leads
        .filter(l => l.tenant_id === tenantId && l.status === 'ingested' && !l.campaign_name)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    }
  },

  async assignLeadsToCampaign(tenantId, campaignId, leadIds) {
    if (!leadIds || leadIds.length === 0) return [];
    
    // Ensure leads are linked via the relational junction table
    await this.addLeadsToCampaign(tenantId, leadIds, campaignId);

    if (supabase) {
      const { data, error } = await supabase
        .from('leads')
        .update({ campaign_name: campaignId, status: 'queued', updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId)
        .in('id', leadIds)
        .select();
      if (error) throw error;

      if (data && data.length > 0) {
        for (const lead of data) {
          await this.enqueueToDialer(tenantId, lead.id, lead.phone, campaignId);
        }
      }

      return data || [];
    } else {
      const updated = [];
      mockDb.leads.forEach(l => {
        if (l.tenant_id === tenantId && leadIds.includes(l.id)) {
          l.campaign_name = campaignId;
          l.status = 'queued';
          l.updated_at = new Date().toISOString();
          updated.push(l);
        }
      });

      for (const lead of updated) {
        await this.enqueueToDialer(tenantId, lead.id, lead.phone, campaignId);
      }

      return updated;
    }
  },

  async getWebhookEndpointsByTenant(tenantId) {
    if (supabase) {
      const { data, error } = await supabase.from('webhook_endpoints').select('*').eq('tenant_id', tenantId).eq('active', true);
      if (error) throw error;
      return data || [];
    } else {
      return (mockDb.webhookEndpoints || []).filter(w => w.tenant_id === tenantId && w.active);
    }
  },

  async getActiveWebhooksByEvent(tenantId, eventName) {
    if (supabase) {
      const { data, error } = await supabase.from('webhook_endpoints').select('*').eq('tenant_id', tenantId).eq('active', true).contains('events', [eventName]);
      if (error) throw error;
      return data || [];
    } else {
      return (mockDb.webhookEndpoints || []).filter(w => w.tenant_id === tenantId && w.active && w.events.includes(eventName));
    }
  },

  async insertWebhookEndpoint(payload) {
    if (supabase) {
      const { data, error } = await supabase.from('webhook_endpoints').insert([payload]).select().single();
      if (error) throw error;
      return data;
    } else {
      mockDb.webhookEndpoints = mockDb.webhookEndpoints || [];
      const hook = { ...payload, active: true, created_at: new Date().toISOString() };
      mockDb.webhookEndpoints.push(hook);
      return hook;
    }
  },

  async deleteWebhookEndpoint(id, tenantId) {
    if (supabase) {
      const { error } = await supabase.from('webhook_endpoints').delete().eq('id', id).eq('tenant_id', tenantId);
      if (error) throw error;
      return true;
    } else {
      mockDb.webhookEndpoints = mockDb.webhookEndpoints || [];
      const len = mockDb.webhookEndpoints.length;
      mockDb.webhookEndpoints = mockDb.webhookEndpoints.filter(w => !(w.id === id && w.tenant_id === tenantId));
      return mockDb.webhookEndpoints.length < len;
    }
  },

  async updateWebhookEndpointActive(id, tenantId, active) {
    if (supabase) {
      const { data, error } = await supabase.from('webhook_endpoints').update({ active, updated_at: new Date().toISOString() }).eq('id', id).eq('tenant_id', tenantId).select().single();
      if (error) throw error;
      return data;
    } else {
      mockDb.webhookEndpoints = mockDb.webhookEndpoints || [];
      const hook = mockDb.webhookEndpoints.find(w => w.id === id && w.tenant_id === tenantId);
      if (hook) {
        hook.active = active;
        hook.updated_at = new Date().toISOString();
      }
      return hook;
    }
  },

  async getWebhookEndpointById(id, tenantId) {
    if (supabase) {
      const { data, error } = await supabase.from('webhook_endpoints').select('*').eq('id', id).eq('tenant_id', tenantId).maybeSingle();
      if (error) throw error;
      return data;
    } else {
      mockDb.webhookEndpoints = mockDb.webhookEndpoints || [];
      return mockDb.webhookEndpoints.find(w => w.id === id && w.tenant_id === tenantId) || null;
    }
  },

  async updateWebhookLastDelivery(id, timestamp) {
    if (supabase) {
      await supabase.from('webhook_endpoints').update({ last_delivery: timestamp }).eq('id', id);
    } else {
      mockDb.webhookEndpoints = mockDb.webhookEndpoints || [];
      const hook = mockDb.webhookEndpoints.find(w => w.id === id);
      if (hook) hook.last_delivery = timestamp;
    }
  },

  async insertExternalCallLog(log) {
    if (supabase) {
      const { data, error } = await supabase.from('external_call_logs').insert([log]).select();
      if (error) throw error;
      return data?.[0] || log;
    }
    const newLog = { id: uuidv4(), ...log };
    mockDb.external_call_logs = mockDb.external_call_logs || [];
    mockDb.external_call_logs.push(newLog);
    return newLog;
  },

  async getExternalCallLogs(filters = {}) {
    if (supabase) {
      let query = supabase.from('external_call_logs').select('*');
      if (filters.tenant_id) query = query.eq('tenant_id', filters.tenant_id);
      if (filters.service) query = query.eq('service', filters.service);
      if (filters.lead_id) query = query.eq('lead_id', filters.lead_id);
      const { data, error } = await query.order('created_at', { ascending: false });
      if (error) throw error;
      return data || [];
    }
    let res = mockDb.external_call_logs || [];
    if (filters.tenant_id) res = res.filter(l => l.tenant_id === filters.tenant_id);
    if (filters.service) res = res.filter(l => l.service === filters.service);
    if (filters.lead_id) res = res.filter(l => l.lead_id === filters.lead_id);
    return res;
  },

  async clearDb() {
    if (supabase) {
      await supabase.from('agent_briefs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await supabase.from('scripts').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await supabase.from('dnc_registry').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await supabase.from('call_events').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await supabase.from('call_sessions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await supabase.from('audit_trail').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      await supabase.from('config_audit_log').delete().neq('id', '00000000-0000-0000-0000-000000000000');
      // tenant_configs uses tenant_id (VARCHAR) as its primary key, not a UUID 'id' column
      await supabase.from('tenant_configs').delete().neq('tenant_id', '');
      await supabase.from('leads').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    } else {
      mockDb.leads = [];
      mockDb.configAuditLog = [];
      mockDb.callSessions = [];
      mockDb.callEvents = [];
      mockDb.auditTrail = [];
      mockDb.dncRegistry = [];
      mockDb.scripts = [];
      mockDb.agentBriefs = [];
      mockDb.jobs = [];
      mockDb.campaigns = [];
      mockDb.leadIngestionErrors = [];
      mockDb.callQueue = [];
      // Re-seed defaults
      mockDb.tenantConfigs = {};
      mockDb.tenantConfigs['default-tenant'] = {
        tenant_id: 'default-tenant',
        tenant_tag: 'defaulttag',
        scoring_weights: { ...DEFAULT_WEIGHTS },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      mockDb.tenantConfigs['test-tenant'] = {
        tenant_id: 'test-tenant',
        tenant_tag: 'testtag',
        scoring_weights: { ...DEFAULT_WEIGHTS },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
    }
  },
  mockDb
};

export default db;
