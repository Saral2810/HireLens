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
