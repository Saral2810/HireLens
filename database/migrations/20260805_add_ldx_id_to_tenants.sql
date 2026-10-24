CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Add tenant_tag column to tenant_configs
ALTER TABLE tenant_configs
ADD COLUMN IF NOT EXISTS tenant_tag VARCHAR(12);

-- Backfill per-row using row id + clock_timestamp as entropy source (guarantees uniqueness and forces per-row evaluation)
UPDATE tenant_configs
SET tenant_tag = (
    SELECT string_agg(
        substr('abcdefghjkmnpqrstuvwxyz23456789',
               1 + (get_byte(digest(tenant_id::text || random()::text || clock_timestamp()::text, 'sha256'), n) % 31),
               1),
        ''
    )
    FROM generate_series(0, 7) AS n
)
WHERE tenant_tag IS NULL;

-- Enforce constraints
ALTER TABLE tenant_configs
ALTER COLUMN tenant_tag SET NOT NULL,
ADD CONSTRAINT uq_tenant_configs_tenant_tag UNIQUE (tenant_tag);
