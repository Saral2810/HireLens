-- Migration: 20260910_lead_consent_tracking.sql
-- Consent tracking column and index for call sessions

ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS consent_status TEXT;
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS consent_captured_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_call_sessions_consent
  ON call_sessions(tenant_id, consent_status) WHERE consent_status IS NOT NULL;
