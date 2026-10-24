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
