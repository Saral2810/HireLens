-- Migration: 01_tenant_isolation_rbac.sql
-- Description: Adds ENUM for RBAC, B-Tree indexes, and Row Level Security for multi-tenancy

BEGIN;

-- ==========================================
-- 1. RBAC Enum setup
-- ==========================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tenant_role') THEN
        CREATE TYPE tenant_role AS ENUM ('owner', 'admin', 'member');
    END IF;
END$$;

-- Clean up any invalid data in tenant_users.role
UPDATE tenant_users 
SET role = 'member' 
WHERE role NOT IN ('owner', 'admin', 'member') OR role IS NULL;

-- Drop default before casting
ALTER TABLE tenant_users ALTER COLUMN role DROP DEFAULT;

-- Convert the role column to the ENUM
ALTER TABLE tenant_users
  ALTER COLUMN role TYPE tenant_role
  USING role::tenant_role;

-- Set default role for future inserts
ALTER TABLE tenant_users ALTER COLUMN role SET DEFAULT 'member'::tenant_role;


-- ==========================================
-- 2. DB Performance Indexes
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_leads_tenant_id ON leads (tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_tenant_created ON leads (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_id ON campaigns (tenant_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_tenant_status ON campaigns (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant_id ON tenant_users (tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user_id ON tenant_users (user_id);

CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant_id ON call_sessions (tenant_id);


-- ==========================================
-- 3. Row Level Security (RLS)
-- ==========================================
-- Enable RLS on core tenant-scoped tables
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;

-- Note: In Supabase, the authenticated user's ID is returned by auth.uid().
-- We check if the current user is associated with the tenant_id of the row they are trying to access.

-- Policy for tenant_users (Users can read their own memberships, or if they are admin/owner of a tenant)
DROP POLICY IF EXISTS "tenant_users_read_policy" ON tenant_users;
CREATE POLICY "tenant_users_read_policy" ON tenant_users
    FOR SELECT
    USING (
        user_id = auth.uid() OR
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = tenant_users.tenant_id
            AND tu.user_id = auth.uid()
            AND tu.role IN ('admin', 'owner')
        )
    );

-- Policy for leads (Users can access leads in tenants they belong to)
DROP POLICY IF EXISTS "leads_tenant_policy" ON leads;
CREATE POLICY "leads_tenant_policy" ON leads
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = leads.tenant_id
            AND tu.user_id = auth.uid()
        )
    );

-- Policy for campaigns
DROP POLICY IF EXISTS "campaigns_tenant_policy" ON campaigns;
CREATE POLICY "campaigns_tenant_policy" ON campaigns
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = campaigns.tenant_id
            AND tu.user_id = auth.uid()
        )
    );

-- Policy for call_sessions
DROP POLICY IF EXISTS "call_sessions_tenant_policy" ON call_sessions;
CREATE POLICY "call_sessions_tenant_policy" ON call_sessions
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = call_sessions.tenant_id
            AND tu.user_id = auth.uid()
        )
    );

COMMIT;
