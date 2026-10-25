-- UP
CREATE TABLE IF NOT EXISTS tenant_voice_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id TEXT NOT NULL,
    provider_type TEXT NOT NULL CHECK (provider_type IN ('gnani', 'mock')),
    encrypted_credentials TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_voice_providers_tenant_type 
ON tenant_voice_providers(tenant_id, provider_type);

-- DOWN (rollback — run these manually only if you need to undo)
-- DROP INDEX IF EXISTS idx_tenant_voice_providers_tenant_type;
-- DROP TABLE IF EXISTS tenant_voice_providers;
