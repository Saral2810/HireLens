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
