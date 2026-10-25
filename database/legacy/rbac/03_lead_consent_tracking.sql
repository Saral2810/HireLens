-- Migration: 03_lead_consent_tracking.sql
-- Lead consent tracking (adds consent_status columns to call_sessions)

ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS consent_status TEXT;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS consent_captured_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_call_sessions_consent
  ON call_sessions(tenant_id, consent_status) WHERE consent_status IS NOT NULL;
