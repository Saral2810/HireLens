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
