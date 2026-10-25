-- Migration: Add tenant_users table and enabled_features to tenant_configs

-- 1. Create tenant_users table to map standard Supabase Auth users to specific tenants
CREATE TABLE IF NOT EXISTS tenant_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id VARCHAR(100) NOT NULL REFERENCES tenant_configs(tenant_id) ON DELETE CASCADE,
    user_id UUID NOT NULL, -- References auth.users in Supabase logically
    role VARCHAR(50) NOT NULL DEFAULT 'admin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(tenant_id, user_id)
);

-- Disable RLS for backend service role access
ALTER TABLE tenant_users DISABLE ROW LEVEL SECURITY;

-- 2. Add enabled_features to tenant_configs
-- We default to giving them the core functionalities to avoid breaking existing flows.
ALTER TABLE tenant_configs ADD COLUMN IF NOT EXISTS enabled_features JSONB NOT NULL DEFAULT '["campaigns", "leads", "agents", "monitor", "crm", "scheduler"]'::jsonb;
