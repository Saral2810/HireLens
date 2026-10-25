ALTER TABLE tenant_voice_providers ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_tenant_voice_providers_active 
  ON tenant_voice_providers(tenant_id, provider_type) WHERE disabled_at IS NULL;
