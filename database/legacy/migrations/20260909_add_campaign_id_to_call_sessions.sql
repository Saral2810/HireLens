-- Add campaign_id to call_sessions for campaign-scoped attempt tracking
ALTER TABLE call_sessions ADD COLUMN IF NOT EXISTS campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_call_sessions_lead_campaign ON call_sessions(lead_id, campaign_id);
