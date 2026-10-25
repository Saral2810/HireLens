-- Migration: 20260910_consolidated_fixes_and_indexes.sql
-- High-throughput indexes for dialer, active leads, call sessions, and tenant leads

CREATE INDEX IF NOT EXISTS idx_call_queue_status_next_attempt ON call_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_call_sessions_provider_session ON call_sessions(provider_session_id);
CREATE INDEX IF NOT EXISTS idx_active_leads_campaign_lead ON active_leads(campaign_id, lead_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_status ON leads(tenant_id, status);
