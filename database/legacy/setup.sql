-- ==============================================================
-- Gnani.ai — ONE-FILE DATABASE SETUP (run once on a NEW Supabase project)
-- Paste into Supabase → SQL Editor → Run. Generated from schema.sql,
-- migrations/ and rbac/ in the correct order.
-- ==============================================================

-- >>>>>>>>>> database/schema.sql
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


-- >>>>>>>>>> database/migrations/01_dialer_internals.sql
-- 01_dialer_internals.sql
-- Dialer Internals - Migration to Postgres-driven state machine

-- 1. TABLES
-- The Five-Table Spine

-- active_leads: The working set. The canonical phone number lives here.
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

-- call_queue: The dialer's work list.
CREATE TABLE IF NOT EXISTS call_queue (
    queue_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    active_lead_id UUID NOT NULL REFERENCES active_leads(active_lead_id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    phone VARCHAR(50) NOT NULL,
    attempt_number INT NOT NULL DEFAULT 1,
    status VARCHAR(50) NOT NULL DEFAULT 'queued', -- queued, dispatched, completed, failed
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    provisional_call_id VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Partial unique index to enforce one pending attempt per lead, ever.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cq_active ON call_queue(active_lead_id) 
WHERE status IN ('queued', 'dispatched');

-- call_logs: Immutable attempt history. Target of LLM extraction.
CREATE TABLE IF NOT EXISTS call_logs (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    active_lead_id UUID NOT NULL REFERENCES active_leads(active_lead_id) ON DELETE CASCADE,
    queue_id UUID REFERENCES call_queue(queue_id) ON DELETE SET NULL,
    call_id VARCHAR(255) UNIQUE NOT NULL, -- Telephony provider's call ID
    phone VARCHAR(50) NOT NULL, -- The dialed string
    status VARCHAR(50) NOT NULL,
    duration_seconds INT NOT NULL DEFAULT 0,
    recording_url TEXT,
    recording_min_role VARCHAR(50) DEFAULT 'admin',
    transcript JSONB,
    qa_extracted BOOLEAN NOT NULL DEFAULT false,
    -- Extracted fields
    lead_classification VARCHAR(50),
    retry_required BOOLEAN NOT NULL DEFAULT false,
    dnd BOOLEAN NOT NULL DEFAULT false,
    purchase_timeline BOOLEAN NOT NULL DEFAULT false,
    callback_at TIMESTAMPTZ,
    motivation TEXT,
    struggle_area TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- archived_leads: Terminal outcomes to keep active_leads small.
CREATE TABLE IF NOT EXISTS archived_leads (
    archive_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    archive_reason VARCHAR(100) NOT NULL,
    archived_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    original_data JSONB NOT NULL
);

-- Concurrency Settings & Slots
CREATE TABLE IF NOT EXISTS concurrency_settings (
    id INT PRIMARY KEY DEFAULT 1, -- Single row
    global_max INT NOT NULL DEFAULT 10,
    global_active INT NOT NULL DEFAULT 0,
    slot_timeout_secs INT NOT NULL DEFAULT 240,
    dispatch_active BOOLEAN NOT NULL DEFAULT false,
    dispatch_run_id VARCHAR(255),
    dispatch_lease_until TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS concurrency_slots (
    slot_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    call_id VARCHAR(255) UNIQUE NOT NULL,
    campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    released BOOLEAN NOT NULL DEFAULT false,
    reserved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at TIMESTAMPTZ
);

-- 2. PL/pgSQL FUNCTIONS

-- fn_dispatch_acquire: Claim the run. Test-and-set in one statement.
CREATE OR REPLACE FUNCTION fn_dispatch_acquire(p_run_id VARCHAR)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_acquired BOOLEAN;
BEGIN
    UPDATE concurrency_settings
    SET dispatch_active = true,
        dispatch_run_id = p_run_id,
        dispatch_lease_until = now() + interval '1 minute'
    WHERE id = 1 
      AND (dispatch_active = false OR dispatch_lease_until < now())
    RETURNING true INTO v_acquired;
    
    RETURN COALESCE(v_acquired, false);
END;
$$;

-- fn_dispatch_release: Release the lease.
CREATE OR REPLACE FUNCTION fn_dispatch_release(p_run_id VARCHAR)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
    UPDATE concurrency_settings
    SET dispatch_active = false,
        dispatch_run_id = NULL
    WHERE id = 1 AND dispatch_run_id = p_run_id;
END;
$$;

-- fn_reserve_slot: Atomically check limits and reserve a slot.
CREATE OR REPLACE FUNCTION fn_reserve_slot(
    p_tenant_id VARCHAR, 
    p_campaign_id UUID, 
    p_call_id VARCHAR, 
    p_run_id VARCHAR
)
RETURNS TABLE (
    allowed BOOLEAN,
    reason VARCHAR,
    out_global_active INT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_settings RECORD;
    v_campaign_active INT;
    v_campaign_max INT;
BEGIN
    -- Check if lead is already dialing (prevent duplicates)
    IF EXISTS (SELECT 1 FROM concurrency_slots WHERE call_id = p_call_id AND released = false) THEN
        RETURN QUERY SELECT false, 'lead_already_dialing'::VARCHAR, 0;
        RETURN;
    END IF;

    -- Lock the settings row to check global capacity
    SELECT * INTO v_settings FROM concurrency_settings WHERE id = 1 FOR UPDATE;
    
    IF v_settings.global_active >= v_settings.global_max THEN
        RETURN QUERY SELECT false, 'global_limit_reached'::VARCHAR, v_settings.global_active;
        RETURN;
    END IF;

    -- Get campaign specific max concurrency
    SELECT max_concurrency INTO v_campaign_max FROM campaigns WHERE id = p_campaign_id;
    
    -- Get current active slots for this campaign
    SELECT COUNT(*) INTO v_campaign_active 
    FROM concurrency_slots 
    WHERE campaign_id = p_campaign_id AND released = false;

    IF v_campaign_active >= v_campaign_max THEN
        RETURN QUERY SELECT false, 'agent_limit_reached'::VARCHAR, v_settings.global_active;
        RETURN;
    END IF;

    -- All checks passed, reserve slot
    INSERT INTO concurrency_slots (tenant_id, campaign_id, call_id)
    VALUES (p_tenant_id, p_campaign_id, p_call_id);

    UPDATE concurrency_settings
    SET global_active = global_active + 1,
        dispatch_lease_until = now() + interval '1 minute'
    WHERE id = 1
    RETURNING global_active INTO out_global_active;

    RETURN QUERY SELECT true, 'allowed'::VARCHAR, out_global_active;
END;
$$;

-- fn_release_slot: Release an active slot
CREATE OR REPLACE FUNCTION fn_release_slot(p_call_id VARCHAR)
RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
    v_released BOOLEAN;
BEGIN
    UPDATE concurrency_slots
    SET released = true,
        released_at = now()
    WHERE call_id = p_call_id AND released = false
    RETURNING true INTO v_released;

    IF v_released THEN
        UPDATE concurrency_settings
        SET global_active = GREATEST(global_active - 1, 0)
        WHERE id = 1;
        RETURN true;
    END IF;

    RETURN false;
END;
$$;

-- fn_reap_stranded_dispatches: Recover slots from calls that never got a webhook.
CREATE OR REPLACE FUNCTION fn_reap_stranded_dispatches()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
    v_timeout INT;
    v_stranded_record RECORD;
BEGIN
    SELECT slot_timeout_secs INTO v_timeout FROM concurrency_settings WHERE id = 1;
    
    FOR v_stranded_record IN 
        SELECT cs.call_id 
        FROM concurrency_slots cs
        WHERE cs.released = false 
          AND cs.reserved_at < (now() - (v_timeout || ' seconds')::interval)
    LOOP
        -- Release slot
        PERFORM fn_release_slot(v_stranded_record.call_id);
        
        -- Mark as failed in call_queue
        UPDATE call_queue 
        SET status = 'failed' 
        WHERE provisional_call_id = v_stranded_record.call_id;
    END LOOP;
END;
$$;

-- Helper function: Returns earliest legal calling slot (09:00-21:00 IST, Mon-Sat)
CREATE OR REPLACE FUNCTION fn_next_callable_slot(p_target TIMESTAMPTZ DEFAULT now())
RETURNS TIMESTAMPTZ
LANGUAGE plpgsql
AS $$
DECLARE
    v_ist TIMESTAMP := (p_target AT TIME ZONE 'Asia/Kolkata');
    v_hour INT := EXTRACT(HOUR FROM v_ist);
    v_dow INT := EXTRACT(DOW FROM v_ist); -- 0 = Sunday
    v_candidate_date DATE := v_ist::date;
BEGIN
    -- If within 9am - 9pm and not Sunday
    IF v_dow != 0 AND v_hour >= 9 AND v_hour < 21 THEN
        RETURN p_target;
    END IF;

    -- If past 9pm, advance to next day
    IF v_hour >= 21 THEN
        v_candidate_date := (v_candidate_date + 1);
    END IF;

    -- Skip Sunday
    WHILE EXTRACT(DOW FROM v_candidate_date) = 0 LOOP
        v_candidate_date := (v_candidate_date + 1);
    END LOOP;

    -- Return 09:00:00 IST converted to timestamptz
    RETURN (v_candidate_date::text || ' 09:00:00+05:30')::timestamptz;
END;
$$;

-- 3. TRIGGERS
-- Trigger to schedule retry when qa_extracted is flipped to true
CREATE OR REPLACE FUNCTION trg_fn_schedule_retry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_cq RECORD;
    v_next_attempt TIMESTAMPTZ;
    v_attempt_cap INT := 3;
BEGIN
    -- Trigger when qa_extracted is true on INSERT or when transitioning to true on UPDATE
    IF NEW.qa_extracted = true AND (TG_OP = 'INSERT' OR OLD.qa_extracted IS NULL OR OLD.qa_extracted = false) THEN
        
        -- BUGFIX 1: ALWAYS release the slot immediately. Do not block this on finding the queue record!
        PERFORM fn_release_slot(NEW.call_id);

        -- BUGFIX 2: Find the original queue record. If queue_id is null (e.g. from webhook), 
        -- resolve it using active_lead_id where status is 'dispatched'.
        IF NEW.queue_id IS NOT NULL THEN
            SELECT * INTO v_cq FROM call_queue WHERE queue_id = NEW.queue_id;
        ELSE
            SELECT * INTO v_cq FROM call_queue 
            WHERE active_lead_id = NEW.active_lead_id AND status = 'dispatched'
            LIMIT 1;
        END IF;

        -- If absolutely no queue record exists, we still return NEW (the slot was already released above)
        IF v_cq IS NULL THEN 
            RETURN NEW; 
        END IF;

        -- Check if it should be retried based on extraction flags
        IF NEW.retry_required = true OR (NEW.lead_classification IS NULL AND NEW.dnd = false) THEN
            
            IF v_cq.attempt_number >= v_attempt_cap THEN
                -- Disqualify due to max attempts
                UPDATE active_leads SET disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            ELSE
                -- Determine backoff time based on attempt number (simplified ladder)
                IF v_cq.attempt_number = 1 THEN
                    v_next_attempt := now() + interval '5 minutes';
                ELSIF v_cq.attempt_number = 2 THEN
                    v_next_attempt := now() + interval '2 hours';
                ELSE
                    v_next_attempt := now() + interval '3 hours';
                END IF;

                -- Override with callback_at if provided
                IF NEW.callback_at IS NOT NULL THEN
                    v_next_attempt := NEW.callback_at;
                END IF;

                -- Ensure retry attempt strictly respects legal calling hours (09:00-21:00 IST, Mon-Sat)
                v_next_attempt := fn_next_callable_slot(v_next_attempt);

                -- Insert new queued row for the next attempt
                -- Use ON CONFLICT DO UPDATE to satisfy the unique index if there's a race
                INSERT INTO call_queue (
                    tenant_id, active_lead_id, campaign_id, phone, attempt_number, next_attempt_at
                ) VALUES (
                    NEW.tenant_id, NEW.active_lead_id, v_cq.campaign_id, NEW.phone, v_cq.attempt_number + 1, v_next_attempt
                )
                ON CONFLICT (active_lead_id) WHERE status IN ('queued', 'dispatched')
                DO UPDATE SET 
                    attempt_number = EXCLUDED.attempt_number,
                    next_attempt_at = EXCLUDED.next_attempt_at;
            END IF;
        ELSE
            -- Terminal state
            IF NEW.dnd = true THEN
                UPDATE active_leads SET dnd = true, disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            END IF;
        END IF;

        -- Mark the original queue item as completed
        UPDATE call_queue SET status = 'completed' WHERE queue_id = v_cq.queue_id;
        
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_c_schedule_retry ON call_logs;
CREATE TRIGGER trg_c_schedule_retry
AFTER INSERT OR UPDATE ON call_logs
FOR EACH ROW
EXECUTE FUNCTION trg_fn_schedule_retry();

-- Trigger to guarantee instant slot release when a call session ends
CREATE OR REPLACE FUNCTION trg_fn_release_slot_on_call_session()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.ended_at IS NOT NULL OR NEW.disposition NOT IN ('calling', 'in-progress', 'in_progress', 'queued') THEN
        IF NEW.provider_session_id IS NOT NULL THEN
            -- Release the slot immediately
            PERFORM fn_release_slot(NEW.provider_session_id);
            
            -- Also sync call_queue status if it was in dispatched state
            UPDATE call_queue
            SET status = CASE 
                WHEN NEW.disposition IN ('completed', 'interested', 'enrolled', 'won') THEN 'completed'
                ELSE 'failed'
            END,
            updated_at = now()
            WHERE provisional_call_id = NEW.provider_session_id 
              AND status = 'dispatched';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_c_release_slot_on_call_session ON call_sessions;
CREATE TRIGGER trg_c_release_slot_on_call_session
AFTER INSERT OR UPDATE ON call_sessions
FOR EACH ROW
EXECUTE FUNCTION trg_fn_release_slot_on_call_session();

-- Insert initial concurrency settings row if it doesn't exist
INSERT INTO concurrency_settings (id, global_max) VALUES (1, 10) ON CONFLICT (id) DO NOTHING;



-- >>>>>>>>>> database/migrations/20260805_add_tenant_tag_to_tenants.sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Add tenant_tag column to tenant_configs
ALTER TABLE tenant_configs
ADD COLUMN IF NOT EXISTS tenant_tag VARCHAR(12);

-- Backfill per-row using row id + clock_timestamp as entropy source (guarantees uniqueness and forces per-row evaluation)
UPDATE tenant_configs
SET tenant_tag = (
    SELECT string_agg(
        substr('abcdefghjkmnpqrstuvwxyz23456789',
               1 + (get_byte(digest(tenant_id::text || random()::text || clock_timestamp()::text, 'sha256'), n) % 31),
               1),
        ''
    )
    FROM generate_series(0, 7) AS n
)
WHERE tenant_tag IS NULL;

-- Enforce constraints
ALTER TABLE tenant_configs
ALTER COLUMN tenant_tag SET NOT NULL,
ADD CONSTRAINT uq_tenant_configs_tenant_tag UNIQUE (tenant_tag);


-- >>>>>>>>>> database/migrations/20260806_add_tenant_users_and_features.sql
-- Migration: Add tenant_users table and enabled_features to tenant_configs

-- 1. Create tenant_users table to map standard Supabase Auth users to specific tenants
CREATE TABLE IF NOT EXISTS tenant_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    user_id UUID NOT NULL, -- References auth.users in Supabase logically
    role VARCHAR(50) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, user_id)
);

-- Disable RLS for backend service role access
ALTER TABLE tenant_users DISABLE ROW LEVEL SECURITY;

-- 2. Add enabled_features to tenant_configs
-- We default to giving them the core functionalities to avoid breaking existing flows.
ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS enabled_features JSONB NOT NULL DEFAULT '["campaigns", "leads", "agents", "monitor", "crm", "scheduler"]'::jsonb;


-- >>>>>>>>>> database/migrations/20260808_add_webhook_endpoints_table.sql
CREATE TABLE webhook_endpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL REFERENCES tenant_configs(tenant_id),
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    events TEXT[] NOT NULL DEFAULT '{}',
    secret TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_endpoints_tenant_active ON webhook_endpoints(tenant_id, active);


-- >>>>>>>>>> database/migrations/20260809_fix_tenant_null_statuses.sql
-- Migration: Fix tenant management system bugs
-- Date: 2026-08-09
-- Description:
--   1. Set all NULL tenant statuses to 'active' so that PostgREST .neq('status','deleted')
--      queries work correctly (NULL rows are silently excluded by .neq() in PostgREST).
--   2. Document the enabled_features convention:
--      NULL = full access (all features enabled)
--      JSON array = restrict to those features only

-- Fix: Normalize all NULL statuses to 'active'
UPDATE tenant_configs
SET status = 'active'
WHERE status IS NULL;

-- Verify
-- SELECT tenant_id, name, status FROM tenant_configs ORDER BY created_at;


-- >>>>>>>>>> database/migrations/20260903_tenant_voice_providers.sql
-- UP
CREATE TABLE IF NOT EXISTS tenant_voice_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('gnani', 'mock')),
    encrypted_credentials TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_voice_providers_tenant_type 
ON tenant_voice_providers(tenant_id, provider_type);

-- DOWN (rollback — run these manually only if you need to undo)
-- DROP INDEX IF EXISTS idx_tenant_voice_providers_tenant_type;
-- DROP TABLE IF EXISTS tenant_voice_providers;


-- >>>>>>>>>> database/migrations/20260904_add_voice_provider_to_campaigns.sql
-- Add voice_provider column to campaigns table
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS voice_provider text;

-- Backfill existing rows to the default provider
UPDATE campaigns SET voice_provider = 'gnani' WHERE voice_provider IS NULL;


-- >>>>>>>>>> database/migrations/20260908_lead_campaigns_junction.sql
-- Junction table for lead ↔ campaign many-to-many
CREATE TABLE IF NOT EXISTS lead_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at TIMESTAMPTZ,
  UNIQUE (lead_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_lead_campaigns_lead ON lead_campaigns(lead_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_campaigns_campaign ON lead_campaigns(campaign_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_lead_campaigns_tenant ON lead_campaigns(tenant_id);

-- Backfill from existing leads.campaign_name comma-separated strings
INSERT INTO lead_campaigns (lead_id, campaign_id, tenant_id)
SELECT DISTINCT l.id, c.id, l.tenant_id
FROM leads l
JOIN LATERAL unnest(string_to_array(l.campaign_name, ',')) AS name(campaign_name) ON true
JOIN campaigns c ON c.tenant_id = l.tenant_id AND lower(trim(c.name)) = lower(trim(name.campaign_name))
WHERE l.campaign_name IS NOT NULL
ON CONFLICT (lead_id, campaign_id) DO NOTHING;


-- >>>>>>>>>> database/migrations/20260909_add_campaign_id_to_call_sessions.sql
-- Add campaign_id to call_sessions for campaign-scoped attempt tracking
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_call_sessions_lead_campaign ON call_sessions(lead_id, campaign_id);


-- >>>>>>>>>> database/migrations/20260909_agent_variable_mappings.sql
CREATE TABLE IF NOT EXISTS agent_variable_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  target_variable TEXT NOT NULL,
  source_expression TEXT NOT NULL,
  transform TEXT,
  is_required BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, provider_type, agent_id, target_variable)
);
CREATE INDEX IF NOT EXISTS idx_agent_var_mappings_lookup
  ON agent_variable_mappings(tenant_id, provider_type, agent_id);


-- >>>>>>>>>> database/migrations/20260909_soft_delete_voice_providers.sql
ALTER TABLE tenant_voice_providers ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tenant_voice_providers_active 
  ON tenant_voice_providers(tenant_id, provider_type) WHERE disabled_at IS NULL;


-- >>>>>>>>>> database/migrations/20260910_consolidated_fixes_and_indexes.sql
-- Migration: 20260910_consolidated_fixes_and_indexes.sql
-- High-throughput indexes for dialer, active leads, call sessions, and tenant leads

CREATE INDEX IF NOT EXISTS idx_call_queue_status_next_attempt ON call_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_session ON call_sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_active_leads_campaign_lead ON active_leads(campaign_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status);


-- >>>>>>>>>> database/migrations/20260910_external_call_logs.sql
-- Migration: 20260910_external_call_logs.sql
-- Unified external-call request/response logger table and indexes

CREATE TABLE IF NOT EXISTS external_call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tenant_id TEXT,
  lead_id TEXT,
  session_id TEXT,
  payload JSONB,
  response_status INT,
  response_body JSONB,
  duration_ms INT,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ext_call_logs_tenant_created
  ON external_call_logs(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ext_call_logs_lead_id
  ON external_call_logs(lead_id);

CREATE INDEX IF NOT EXISTS idx_ext_call_logs_service_status
  ON external_call_logs(service, response_status);


-- >>>>>>>>>> database/migrations/20260910_lead_consent_tracking.sql
-- Migration: 20260910_lead_consent_tracking.sql
-- Consent tracking column and index for call sessions

ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS consent_status TEXT;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS consent_captured_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_call_sessions_consent
  ON call_sessions(tenant_id, consent_status) WHERE consent_status IS NOT NULL;


-- >>>>>>>>>> database/migrations/20260911_add_launch_strategy_to_campaigns.sql
-- Add launch_strategy to campaigns table to support tracking immediate vs scheduled vs draft auto-launches
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS launch_strategy VARCHAR(50) DEFAULT NULL;


-- >>>>>>>>>> database/migrations/20260912_add_outcome_score.sql
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS outcome_score INT;


-- >>>>>>>>>> database/migrations/20260912_call_queue_active_lead_unique.sql
CREATE UNIQUE INDEX IF NOT EXISTS call_queue_active_lead_uniq
ON call_queue (phone)
WHERE status IN ('queued', 'calling');


-- >>>>>>>>>> database/migrations/20260912_patch_retry_trigger.sql
CREATE OR REPLACE FUNCTION trg_fn_schedule_retry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_cq RECORD;
    v_next_attempt TIMESTAMPTZ;
    v_attempt_cap INT := 3;
BEGIN
    -- Trigger when qa_extracted is true on INSERT or when transitioning to true on UPDATE
    IF NEW.qa_extracted = true AND (TG_OP = 'INSERT' OR OLD.qa_extracted IS NULL OR OLD.qa_extracted = false) THEN
        
        -- BUGFIX 1: ALWAYS release the slot immediately. Do not block this on finding the queue record!
        PERFORM fn_release_slot(NEW.call_id);

        -- BUGFIX 2: Find the original queue record. If queue_id is null (e.g. from webhook), 
        -- resolve it using active_lead_id where status is 'dispatched'.
        IF NEW.queue_id IS NOT NULL THEN
            SELECT * INTO v_cq FROM call_queue WHERE queue_id = NEW.queue_id;
        ELSE
            SELECT * INTO v_cq FROM call_queue 
            WHERE active_lead_id = NEW.active_lead_id AND status = 'dispatched'
            LIMIT 1;
        END IF;

        -- If absolutely no queue record exists, we still return NEW (the slot was already released above)
        IF v_cq IS NULL THEN 
            RETURN NEW; 
        END IF;

        -- Check if it should be retried based on extraction flags
        IF NEW.retry_required = true OR (NEW.lead_classification IS NULL AND NEW.dnd = false) THEN
            
            IF v_cq.attempt_number >= v_attempt_cap THEN
                -- Disqualify due to max attempts
                UPDATE active_leads SET disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            ELSE
                -- Determine backoff time based on attempt number (simplified ladder)
                IF v_cq.attempt_number = 1 THEN
                    v_next_attempt := now() + interval '5 minutes';
                ELSIF v_cq.attempt_number = 2 THEN
                    v_next_attempt := now() + interval '2 hours';
                ELSE
                    v_next_attempt := now() + interval '3 hours';
                END IF;

                -- Override with callback_at if provided
                IF NEW.callback_at IS NOT NULL THEN
                    v_next_attempt := NEW.callback_at;
                END IF;

                -- Ensure retry attempt strictly respects legal calling hours (09:00-21:00 IST, Mon-Sat)
                v_next_attempt := fn_next_callable_slot(v_next_attempt);

                -- Insert new queued row for the next attempt
                -- Use ON CONFLICT DO UPDATE to satisfy the unique index if there's a race
                BEGIN
                    INSERT INTO call_queue (
                        tenant_id, active_lead_id, campaign_id, phone, attempt_number, next_attempt_at
                    ) VALUES (
                        NEW.tenant_id, NEW.active_lead_id, v_cq.campaign_id, NEW.phone, v_cq.attempt_number + 1, v_next_attempt
                    )
                    ON CONFLICT (active_lead_id) WHERE status IN ('queued', 'dispatched')
                    DO UPDATE SET 
                        attempt_number = EXCLUDED.attempt_number,
                        next_attempt_at = EXCLUDED.next_attempt_at;
                EXCEPTION WHEN unique_violation THEN
                    RAISE NOTICE '[RetryGuard] Phone % is already active in another campaign. Swallowing retry.', NEW.phone;
                END;
            END IF;
        ELSE
            -- Terminal state
            IF NEW.dnd = true THEN
                UPDATE active_leads SET dnd = true, disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


-- >>>>>>>>>> database/migrations/20260912_reap_stale_slots.sql
CREATE OR REPLACE FUNCTION reap_stale_slots(p_older_than_secs INT DEFAULT 240)
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE
    n INT;
BEGIN
    UPDATE concurrency_slots
    SET released = true, released_at = now()
    WHERE released = false 
      AND reserved_at < now() - (p_older_than_secs || ' seconds')::interval;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n > 0 THEN
      UPDATE concurrency_settings SET global_active = GREATEST(global_active - n, 0) WHERE id = 1;
      RAISE NOTICE '[reap_stale_slots] Released % stale slots', n;
    END IF;
    RETURN n;
END;
$$;


-- >>>>>>>>>> database/migrations/20260913_patch_retry_trigger_pause_guard.sql
-- Add campaign-status guard to trg_fn_schedule_retry
-- Prevents zombie call_queue rows for paused campaigns after in-flight calls complete
CREATE OR REPLACE FUNCTION trg_fn_schedule_retry()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_cq RECORD;
    v_next_attempt TIMESTAMPTZ;
    v_attempt_cap INT := 3;
    v_campaign_status TEXT;
BEGIN
    IF NEW.qa_extracted = true AND (TG_OP = 'INSERT' OR OLD.qa_extracted IS NULL OR OLD.qa_extracted = false) THEN
        PERFORM fn_release_slot(NEW.call_id);

        IF NEW.queue_id IS NOT NULL THEN
            SELECT * INTO v_cq FROM call_queue WHERE queue_id = NEW.queue_id;
        ELSE
            SELECT * INTO v_cq FROM call_queue
            WHERE active_lead_id = NEW.active_lead_id AND status = 'dispatched'
            LIMIT 1;
        END IF;

        IF v_cq IS NULL THEN
            RETURN NEW;
        END IF;

        -- NEW: If the campaign is not active, do not enqueue a retry row.
        -- Slot is already released above; this just prevents zombie queue rows.
        SELECT status INTO v_campaign_status FROM campaigns WHERE id = v_cq.campaign_id;
        IF v_campaign_status IS DISTINCT FROM 'active' THEN
            RAISE NOTICE '[RetryGuard] Campaign % is %, skipping retry enqueue.', v_cq.campaign_id, v_campaign_status;
            RETURN NEW;
        END IF;

        IF NEW.retry_required = true OR (NEW.lead_classification IS NULL AND NEW.dnd = false) THEN
            IF v_cq.attempt_number >= v_attempt_cap THEN
                UPDATE active_leads SET disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            ELSE
                IF v_cq.attempt_number = 1 THEN
                    v_next_attempt := now() + interval '5 minutes';
                ELSIF v_cq.attempt_number = 2 THEN
                    v_next_attempt := now() + interval '2 hours';
                ELSE
                    v_next_attempt := now() + interval '3 hours';
                END IF;

                IF NEW.callback_at IS NOT NULL THEN
                    v_next_attempt := NEW.callback_at;
                END IF;

                v_next_attempt := fn_next_callable_slot(v_next_attempt);

                BEGIN
                    INSERT INTO call_queue (
                        tenant_id, active_lead_id, campaign_id, phone, attempt_number, next_attempt_at
                    ) VALUES (
                        NEW.tenant_id, NEW.active_lead_id, v_cq.campaign_id, NEW.phone, v_cq.attempt_number + 1, v_next_attempt
                    )
                    ON CONFLICT (active_lead_id) WHERE status IN ('queued', 'dispatched')
                    DO UPDATE SET
                        attempt_number = EXCLUDED.attempt_number,
                        next_attempt_at = EXCLUDED.next_attempt_at;
                EXCEPTION WHEN unique_violation THEN
                    RAISE NOTICE '[RetryGuard] Phone % is already active in another campaign. Swallowing retry.', NEW.phone;
                END;
            END IF;
        ELSE
            IF NEW.dnd = true THEN
                UPDATE active_leads SET dnd = true, disqualified = true WHERE active_lead_id = NEW.active_lead_id;
            END IF;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


-- >>>>>>>>>> database/migrations/20260915_lead_notes.sql
-- Migration: 20260915_lead_notes.sql
-- Create lead_notes table for internal agent notes and commentary on leads

CREATE TABLE IF NOT EXISTS public.lead_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL,
    lead_id UUID NOT NULL REFERENCES public.leads(id) ON DELETE CASCADE,
    agent_id VARCHAR(100) DEFAULT 'system',
    note_text TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- High-throughput index for loading notes by lead and tenant ordered by creation time
CREATE INDEX IF NOT EXISTS idx_lead_notes_lookup ON public.lead_notes(tenant_id, lead_id, created_at DESC);

-- Disable RLS or set permissive for backend service role operations matching existing architecture
ALTER TABLE public.lead_notes DISABLE ROW LEVEL SECURITY;


-- >>>>>>>>>> database/migrations/20260926_enable_rls_lead_notes.sql
-- Migration: 20260926_enable_rls_lead_notes.sql
-- Description: Enable RLS and add tenant isolation policy for lead_notes

ALTER TABLE "public"."lead_notes" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE tablename = 'lead_notes' AND policyname = 'lead_notes_tenant_policy'
  ) THEN
    CREATE POLICY "lead_notes_tenant_policy" ON "public"."lead_notes"
      FOR ALL
      TO authenticated
      USING (
        EXISTS (
          SELECT 1 FROM public.tenant_users tu
          WHERE tu.tenant_id = lead_notes.tenant_id::text
            AND tu.user_id = (SELECT auth.uid())
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM public.tenant_users tu
          WHERE tu.tenant_id = lead_notes.tenant_id::text
            AND tu.user_id = (SELECT auth.uid())
        )
      );
  END IF;
END $$;


-- >>>>>>>>>> database/migrations/20261001_fix_campaigns_and_leads_rls.sql
-- Migration: 20261001_fix_campaigns_and_leads_rls.sql
-- Description: Fix Row Level Security (RLS) policies for campaigns and leads to support superadmins, tenant users, and backend services

BEGIN;

-- Super admins are recognised by the Supabase app_metadata flag is_super_admin = true.
-- Set it once for your admin user (SQL editor):
--   UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"is_super_admin": true}' WHERE email = 'you@example.com';

-- 1. Update campaigns RLS policy
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaigns_tenant_policy" ON campaigns;
CREATE POLICY "campaigns_tenant_policy" ON campaigns
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = campaigns.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = campaigns.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    );

-- 2. Update leads RLS policy
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leads_tenant_policy" ON leads;
CREATE POLICY "leads_tenant_policy" ON leads
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = leads.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = leads.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    );

COMMIT;


-- >>>>>>>>>> database/rbac/01_tenant_isolation_rbac.sql
-- Migration: 01_tenant_isolation_rbac.sql
-- Description: Adds ENUM for RBAC, B-Tree indexes, and Row Level Security for multi-tenancy

BEGIN;

-- ==========================================
-- 1. RBAC Enum setup
-- ==========================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_role') THEN
        CREATE TYPE tenant_role AS ENUM ('owner', 'admin', 'member');
    END IF;
END$$;

-- Clean up any invalid data in tenant_users.role
UPDATE tenant_users 
SET role = 'member' 
WHERE role NOT IN ('owner', 'admin', 'member') OR role IS NULL;

-- Drop default before casting
ALTER TABLE tenant_users ALTER COLUMN role DROP DEFAULT;

-- Convert the role column to the ENUM
ALTER TABLE tenant_users
  ALTER COLUMN role TYPE tenant_role
  USING role::tenant_role;

-- Set default role for future inserts
ALTER TABLE tenant_users ALTER COLUMN role SET DEFAULT 'member'::tenant_role;


-- ==========================================
-- 2. DB Performance Indexes
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_leads_tenant_id ON leads (tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_id ON campaigns (tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_status ON campaigns (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant_id ON tenant_users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user_id ON tenant_users (user_id);

CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_id ON call_sessions (tenant_id);


-- ==========================================
-- 3. Row Level Security (RLS)
-- ==========================================
-- Enable RLS on core tenant-scoped tables
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

-- Note: In Supabase, the authenticated user's ID is returned by auth.uid().
-- We check if the current user is associated with the tenant_id of the row they are trying to access.

-- Policy for tenant_users (Users can read their own memberships, or if they are admin/owner of a tenant)
DROP POLICY IF EXISTS "tenant_users_read_policy" ON tenant_users;
CREATE POLICY "tenant_users_read_policy" ON tenant_users
    FOR SELECT
    USING (
        user_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = tenant_users.tenant_id
            AND tu.user_id = auth.uid()
            AND tu.role IN ('admin', 'owner')
        )
    );

-- Policy for leads (Users can access leads in tenants they belong to)
DROP POLICY IF EXISTS "leads_tenant_policy" ON leads;
CREATE POLICY "leads_tenant_policy" ON leads
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = leads.tenant_id
            AND tu.user_id = auth.uid()
        )
    );

-- Policy for campaigns
DROP POLICY IF EXISTS "campaigns_tenant_policy" ON campaigns;
CREATE POLICY "campaigns_tenant_policy" ON campaigns
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = campaigns.tenant_id
            AND tu.user_id = auth.uid()
        )
    );

-- Policy for call_sessions
DROP POLICY IF EXISTS "call_sessions_tenant_policy" ON call_sessions;
CREATE POLICY "call_sessions_tenant_policy" ON call_sessions
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = call_sessions.tenant_id
            AND tu.user_id = auth.uid()
        )
    );

COMMIT;


-- >>>>>>>>>> database/rbac/02_provider_soft_delete_and_agent_variable_mappings.sql
-- Provider soft-delete
ALTER TABLE tenant_voice_providers ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tenant_voice_providers_active
  ON tenant_voice_providers(tenant_id, provider_type) WHERE disabled_at IS NULL;

-- Agent variable mappings
CREATE TABLE IF NOT EXISTS agent_variable_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id TEXT NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  target_variable TEXT NOT NULL,
  source_expression TEXT NOT NULL,
  transform TEXT,
  is_required BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(tenant_id, provider_type, agent_id, target_variable)
);
CREATE INDEX IF NOT EXISTS idx_agent_var_mappings_lookup
  ON agent_variable_mappings(tenant_id, provider_type, agent_id);


-- >>>>>>>>>> database/rbac/03_lead_consent_tracking.sql
-- Migration: 03_lead_consent_tracking.sql
-- Lead consent tracking (adds consent_status columns to call_sessions)

ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS consent_status TEXT;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS consent_captured_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_call_sessions_consent
  ON call_sessions(tenant_id, consent_status) WHERE consent_status IS NOT NULL;


-- >>>>>>>>>> database/rbac/04_fix_campaigns_and_leads_rls.sql
-- Migration: 04_fix_campaigns_and_leads_rls.sql
-- Description: Fix Row Level Security (RLS) policies for campaigns and leads to support superadmins, tenant users, and backend services

BEGIN;

-- Super admins are recognised by the Supabase app_metadata flag is_super_admin = true.
-- Set it once for your admin user (SQL editor):
--   UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"is_super_admin": true}' WHERE email = 'you@example.com';

-- 1. Update campaigns RLS policy
-- Previously, the policy only checked tenant_users directly without superadmin bypass or WITH CHECK clause.
-- This caused RLS violations when superadmins, newly created tenants, or backend ingest workers created campaigns.
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaigns_tenant_policy" ON campaigns;
CREATE POLICY "campaigns_tenant_policy" ON campaigns
    FOR ALL
    TO authenticated
    USING (
        -- User belongs to this tenant
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = campaigns.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        -- OR User is a SuperAdmin (via email or app_metadata)
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = campaigns.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    );

-- 2. Update leads RLS policy with matching SuperAdmin bypass and WITH CHECK
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leads_tenant_policy" ON leads;
CREATE POLICY "leads_tenant_policy" ON leads
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = leads.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = leads.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    );

COMMIT;


-- >>>>>>>>>> database/migrations/20261024_hr_candidate_fields.sql
-- Migration: 20261024_hr_candidate_fields.sql
-- HR calling: candidate details uploaded by HR + screening result filled after the call.
-- A "lead" row is a candidate.

ALTER TABLE leads ADD COLUMN IF NOT EXISTS job_role VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS current_company VARCHAR(255);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS experience_years NUMERIC(4, 1);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS current_ctc NUMERIC(12, 2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS expected_ctc NUMERIC(12, 2);
ALTER TABLE leads ADD COLUMN IF NOT EXISTS notice_period_days INT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS skills TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS resume_url TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS interview_slot TIMESTAMPTZ;
-- pending | shortlisted | maybe | rejected | not_interested
ALTER TABLE leads ADD COLUMN IF NOT EXISTS screening_status VARCHAR(50) NOT NULL DEFAULT 'pending';
-- Answers the agent collected on the call (notice period, CTC, availability, ...)
ALTER TABLE leads ADD COLUMN IF NOT EXISTS screening_answers JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_leads_tenant_screening ON leads(tenant_id, screening_status);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_job_role ON leads(tenant_id, job_role);


-- >>>>>>>>>> database/migrations/20261024_tenant_tag_default.sql
-- Migration: 20261024_tenant_tag_default.sql
-- tenant_tag is NOT NULL (20260805), but several upserts in config/db.js create a tenant row
-- without one. Generate an 8-character tag by default (matches parseAgentName's [a-z0-9]{6,16}).

ALTER TABLE tenant_configs
ALTER COLUMN tenant_tag SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);


-- >>>>>>>>>> database/migrations/20261024_enable_rls_all_tables.sql
-- Migration: 20261024_enable_rls_all_tables.sql
-- Security hardening. Earlier migrations DISABLE row level security on most tables, which in
-- Supabase lets anyone holding the publishable (anon) key read and write them through the Data API.
-- The backend only uses the service-role key (config/db.js), which bypasses RLS, so turning RLS on
-- with no extra policies closes the public API without changing app behaviour.

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END $$;

-- Pin search_path on the dialer functions so a caller's search_path can't redirect them.
DO $$
DECLARE
    f RECORD;
BEGIN
    FOR f IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('fn_dispatch_acquire', 'fn_dispatch_release', 'fn_reserve_slot', 'fn_release_slot',
                            'fn_reap_stranded_dispatches', 'fn_next_callable_slot', 'reap_stale_slots',
                            'trg_fn_schedule_retry', 'trg_fn_release_slot_on_call_session')
    LOOP
        EXECUTE format('ALTER FUNCTION public.%I(%s) SET search_path = public, pg_temp', f.proname, f.args);
    END LOOP;
END $$;
