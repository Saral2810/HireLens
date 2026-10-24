-- Drop constraints and column from tenant_configs
ALTER TABLE tenant_configs
DROP CONSTRAINT IF EXISTS uq_tenant_configs_tenant_tag;

ALTER TABLE tenant_configs
DROP COLUMN IF EXISTS tenant_tag;
