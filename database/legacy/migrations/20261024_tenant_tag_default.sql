-- Migration: 20261024_tenant_tag_default.sql
-- tenant_tag is NOT NULL (20260805), but several upserts in config/db.js create a tenant row
-- without one. Generate an 8-character tag by default (matches parseAgentName's [a-z0-9]{6,16}).

ALTER TABLE tenant_configs
ALTER COLUMN tenant_tag SET DEFAULT substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
