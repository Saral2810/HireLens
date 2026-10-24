-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Table: leads
CREATE TABLE IF NOT EXISTS leads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    name VARCHAR(255),
    phone VARCHAR(50) NOT NULL,
    email VARCHAR(255),
    source VARCHAR(100) NOT NULL,
    raw_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    score INT NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'ingested',
    dataset_id VARCHAR(100),
    campaign_name VARCHAR(100),
    client_id VARCHAR(255),
    unique_id VARCHAR(100),
    product_type VARCHAR(100),
    business_type VARCHAR(100),
    supporting_data JSONB DEFAULT '[]'::jsonb,
    offer_amount NUMERIC(12, 2),
    roi_pct NUMERIC(5, 2),
    max_tenure_months INT,
    emi_indicative NUMERIC(12, 2),
    offer_expiry_date TIMESTAMPTZ,
    priority_band VARCHAR(10),
    preferred_language VARCHAR(50),
    city VARCHAR(100),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index to prevent duplicate leads under the same tenant
CREATE UNIQUE INDEX IF NOT EXISTS leads_tenant_phone_idx ON leads(tenant_id, phone);

-- Table: campaigns
CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    name VARCHAR(255) NOT NULL DEFAULT 'Untitled Campaign',
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    total_leads INT NOT NULL DEFAULT 0,
    processed_leads INT NOT NULL DEFAULT 0,
    failed_leads INT NOT NULL DEFAULT 0,
    ingested INT NOT NULL DEFAULT 0,
    connected INT NOT NULL DEFAULT 0,
    scheduled_at TIMESTAMPTZ,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    job_id VARCHAR(255),
    whatsapp_threshold INT NOT NULL DEFAULT 70,
    max_concurrency INT NOT NULL DEFAULT 3,
    voice_agent_id VARCHAR(100),
    voice_provider VARCHAR(50) DEFAULT 'gnani',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table: background_jobs
CREATE TABLE IF NOT EXISTS background_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    job_type VARCHAR(100) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    result JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table: call_sessions
CREATE TABLE IF NOT EXISTS call_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    provider_session_id VARCHAR(255),
    script_version VARCHAR(50),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    duration INT,
    transcript_json JSONB,
    sentiment VARCHAR(50),
    analysis JSONB,
    recording_url TEXT,
    disposition VARCHAR(100),
    summary TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table: call_events
CREATE TABLE IF NOT EXISTS call_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    session_id UUID NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
    event_type VARCHAR(100) NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table: tenant_configs
-- NOTE: The live DB schema has evolved beyond the original schema.sql.
-- This table now uses top-level JSONB columns for each config domain.
-- enabled_features = NULL means "full access" (all features enabled).
CREATE TABLE IF NOT EXISTS tenant_configs (
    tenant_id VARCHAR(100) PRIMARY KEY,
    name VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    tenant_tag VARCHAR(50) UNIQUE,
    "aiAgent" JSONB NOT NULL DEFAULT '{}'::jsonb,
    queue JSONB NOT NULL DEFAULT '{}'::jsonb,
    ingestion JSONB NOT NULL DEFAULT '{}'::jsonb,
    crm JSONB NOT NULL DEFAULT '{}'::jsonb,
    scoring_weights JSONB NOT NULL DEFAULT '{
        "demographic_fit": 0.25,
        "source_quality": 0.25,
        "recency": 0.20,
        "behavioural_signals": 0.15,
        "prior_interaction": 0.15
    }'::jsonb,
    onboarding_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    eleven_labs_api_key VARCHAR(255),
    eleven_labs_agent_id VARCHAR(100),
    -- NULL means "all features enabled" (full access); a JSON array restricts to listed features
    enabled_features JSONB DEFAULT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table: config_audit_log
CREATE TABLE IF NOT EXISTS config_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    changed_by VARCHAR(255) NOT NULL,
    config_type VARCHAR(100) NOT NULL,
    old_value JSONB,
    new_value JSONB,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table: audit_trail (centralized logbook for system events)
CREATE TABLE IF NOT EXISTS audit_trail (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table: tenant_users
CREATE TABLE IF NOT EXISTS tenant_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    email VARCHAR(255),
    temp_password VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, user_id)
);

-- Table: dnc_registry
CREATE TABLE IF NOT EXISTS dnc_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index to prevent duplicate DNC listings for same tenant
CREATE UNIQUE INDEX IF NOT EXISTS dnc_tenant_phone_idx ON dnc_registry(tenant_id, phone);

-- Table: scripts
CREATE TABLE IF NOT EXISTS scripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    script_id VARCHAR(100) NOT NULL,
    version VARCHAR(50) NOT NULL,
    language VARCHAR(50) NOT NULL DEFAULT 'en',
    nodes JSONB NOT NULL DEFAULT '[]'::jsonb,
    escalation_triggers JSONB NOT NULL DEFAULT '[]'::jsonb,
    max_duration_seconds INT NOT NULL DEFAULT 300,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS scripts_tenant_script_version_idx ON scripts(tenant_id, script_id, version);

-- Table: agent_briefs
CREATE TABLE IF NOT EXISTS agent_briefs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
    brief JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Disable Row Level Security (RLS) for demo/local sandbox access via Publishable API Key
ALTER TABLE leads DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_configs DISABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users DISABLE ROW LEVEL SECURITY;
ALTER TABLE call_sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE call_events DISABLE ROW LEVEL SECURITY;
ALTER TABLE config_audit_log DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_trail DISABLE ROW LEVEL SECURITY;
ALTER TABLE dnc_registry DISABLE ROW LEVEL SECURITY;
ALTER TABLE scripts DISABLE ROW LEVEL SECURITY;
ALTER TABLE agent_briefs DISABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns DISABLE ROW LEVEL SECURITY;
ALTER TABLE background_jobs DISABLE ROW LEVEL SECURITY;

-- Table: api_keys
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    api_key VARCHAR(255) NOT NULL UNIQUE,
    description VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE api_keys DISABLE ROW LEVEL SECURITY;

-- Table: consent_logs
CREATE TABLE IF NOT EXISTS consent_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    action VARCHAR(100) NOT NULL,
    source VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE consent_logs DISABLE ROW LEVEL SECURITY;

-- Table: compliance_dnc_logs
CREATE TABLE IF NOT EXISTS compliance_dnc_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    phone VARCHAR(50) NOT NULL,
    scrubbed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status VARCHAR(50) NOT NULL
);
ALTER TABLE compliance_dnc_logs DISABLE ROW LEVEL SECURITY;

-- Table: cross_sell_logs
CREATE TABLE IF NOT EXISTS cross_sell_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    product_type VARCHAR(100) NOT NULL,
    consent_given BOOLEAN NOT NULL,
    source VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE cross_sell_logs DISABLE ROW LEVEL SECURITY;

-- Table: data_purge_logs
CREATE TABLE IF NOT EXISTS data_purge_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    purged_fields JSONB NOT NULL,
    purged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE data_purge_logs DISABLE ROW LEVEL SECURITY;

-- ==========================================================
-- DIALER INTERNALS & STATE MACHINE
-- ==========================================================

-- Table: active_leads
CREATE TABLE IF NOT EXISTS active_leads (
    active_lead_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    phone VARCHAR(50) NOT NULL,
    total_attempts INT NOT NULL DEFAULT 0,
    total_connects INT NOT NULL DEFAULT 0,
    dnd BOOLEAN NOT NULL DEFAULT false,
    lead_classification VARCHAR(50),
    disqualified BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE active_leads DISABLE ROW LEVEL SECURITY;

-- Table: call_queue
CREATE TABLE IF NOT EXISTS call_queue (
    queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    active_lead_id UUID NOT NULL REFERENCES active_leads(active_lead_id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    phone VARCHAR(50) NOT NULL,
    attempt_number INT NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    provisional_call_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE call_queue DISABLE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS uq_cq_active ON call_queue(active_lead_id) 
WHERE status IN ('queued', 'dispatched');

-- Table: call_logs
CREATE TABLE IF NOT EXISTS call_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    active_lead_id UUID NOT NULL REFERENCES active_leads(active_lead_id) ON DELETE CASCADE,
    queue_id UUID REFERENCES call_queue(queue_id) ON DELETE SET NULL,
    call_id VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL,
    duration_seconds INT NOT NULL DEFAULT 0,
    recording_url TEXT,
    recording_min_role VARCHAR(50) DEFAULT 'admin',
    transcript JSONB,
    qa_extracted BOOLEAN NOT NULL DEFAULT false,
    lead_classification VARCHAR(50),
    retry_required BOOLEAN NOT NULL DEFAULT false,
    dnd BOOLEAN NOT NULL DEFAULT false,
    purchase_timeline BOOLEAN NOT NULL DEFAULT false,
    callback_at TIMESTAMPTZ,
    motivation TEXT,
    struggle_area TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE call_logs DISABLE ROW LEVEL SECURITY;

-- Table: archived_leads
CREATE TABLE IF NOT EXISTS archived_leads (
    archive_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    archive_reason VARCHAR(100) NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    original_data JSONB NOT NULL
);
ALTER TABLE archived_leads DISABLE ROW LEVEL SECURITY;

-- Table: concurrency_settings
CREATE TABLE IF NOT EXISTS concurrency_settings (
    id INT PRIMARY KEY DEFAULT 1,
    global_max INT NOT NULL DEFAULT 10,
    global_active INT NOT NULL DEFAULT 0,
    slot_timeout_secs INT NOT NULL DEFAULT 240,
    dispatch_active BOOLEAN NOT NULL DEFAULT false,
    dispatch_run_id VARCHAR(255),
    dispatch_lease_until TIMESTAMPTZ
);
ALTER TABLE concurrency_settings DISABLE ROW LEVEL SECURITY;
INSERT INTO concurrency_settings (id, global_max) VALUES (1, 10) ON CONFLICT (id) DO NOTHING;

-- Table: concurrency_slots
CREATE TABLE IF NOT EXISTS concurrency_slots (
    slot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    call_id VARCHAR(255) UNIQUE NOT NULL,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    released BOOLEAN NOT NULL DEFAULT false,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ
);
ALTER TABLE concurrency_slots DISABLE ROW LEVEL SECURITY;

-- ==========================================================
-- RELATIONAL EXTENSIONS & MULTI-PROVIDER AGENTS
-- ==========================================================

-- Table: lead_campaigns (Many-to-Many junction)
CREATE TABLE IF NOT EXISTS lead_campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at TIMESTAMPTZ,
    UNIQUE (lead_id, campaign_id)
);
ALTER TABLE lead_campaigns DISABLE ROW LEVEL SECURITY;

-- Table: tenant_voice_providers
CREATE TABLE IF NOT EXISTS tenant_voice_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    provider_type VARCHAR(50) NOT NULL CHECK (provider_type IN ('gnani', 'mock')),  -- add new providers here
    encrypted_credentials TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE tenant_voice_providers DISABLE ROW LEVEL SECURITY;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_voice_providers_tenant_type 
ON tenant_voice_providers(tenant_id, provider_type);

-- Table: agent_variable_mappings
CREATE TABLE IF NOT EXISTS agent_variable_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    provider_type VARCHAR(50) NOT NULL,
    agent_id VARCHAR(100) NOT NULL,
    target_variable VARCHAR(100) NOT NULL,
    source_expression TEXT NOT NULL,
    transform VARCHAR(50),
    is_required BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, provider_type, agent_id, target_variable)
);
ALTER TABLE agent_variable_mappings DISABLE ROW LEVEL SECURITY;

-- Table: external_call_logs
CREATE TABLE IF NOT EXISTS external_call_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service VARCHAR(100) NOT NULL,
    endpoint TEXT NOT NULL,
    method VARCHAR(20) NOT NULL,
    request_id VARCHAR(255) NOT NULL,
    tenant_id VARCHAR(100),
    lead_id VARCHAR(100),
    session_id VARCHAR(100),
    payload JSONB,
    response_status INT,
    response_body JSONB,
    duration_ms INT,
    error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE external_call_logs DISABLE ROW LEVEL SECURITY;

-- Table: campaign_drafts
CREATE TABLE IF NOT EXISTS campaign_drafts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    step INT NOT NULL DEFAULT 1,
    campaign_name VARCHAR(255) NOT NULL DEFAULT 'Untitled Draft',
    form_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id)
);
ALTER TABLE campaign_drafts DISABLE ROW LEVEL SECURITY;

-- ==========================================================
-- HIGH-THROUGHPUT INDEXES
-- ==========================================================
CREATE INDEX IF NOT EXISTS idx_call_queue_status_next_attempt ON call_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_session ON call_sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_active_leads_campaign_lead ON active_leads(campaign_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_lead_campaigns_lead ON lead_campaigns(lead_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_campaigns_campaign ON lead_campaigns(campaign_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_campaigns_tenant ON lead_campaigns(tenant_id);
CREATE INDEX IF NOT EXISTS idx_agent_var_mappings_lookup ON agent_variable_mappings(tenant_id, provider_type, agent_id);
CREATE INDEX IF NOT EXISTS idx_ext_call_logs_tenant_created ON external_call_logs(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ext_call_logs_lead_id ON external_call_logs(lead_id);
CREATE INDEX IF NOT EXISTS idx_ext_call_logs_service_status ON external_call_logs(service, response_status);
CREATE INDEX IF NOT EXISTS idx_tenant_voice_providers_active ON tenant_voice_providers(tenant_id, provider_type) WHERE disabled_at IS NULL;

-- Table: lead_notes
CREATE TABLE IF NOT EXISTS lead_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    agent_id VARCHAR(100) DEFAULT 'system',
    note_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE lead_notes ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_lead_notes_lookup ON lead_notes(tenant_id, lead_id, created_at DESC);

CREATE POLICY lead_notes_tenant_policy ON lead_notes
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM tenant_users tu
      WHERE tu.tenant_id = lead_notes.tenant_id::text
        AND tu.user_id = (SELECT auth.uid())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM tenant_users tu
      WHERE tu.tenant_id = lead_notes.tenant_id::text
        AND tu.user_id = (SELECT auth.uid())
    )
  );
