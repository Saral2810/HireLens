-- Migration: 04_fix_campaigns_and_leads_rls.sql
-- Description: Fix Row Level Security (RLS) policies for campaigns and leads to support superadmins, tenant users, and backend services

BEGIN;

-- Super admins are recognised by the Supabase app_metadata flag is_super_admin = true.
-- Set it once for your admin user (SQL editor):
--   UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"is_super_admin": true}' WHERE email = 'you@example.com';

-- 1. Update campaigns RLS policy
-- Previously, the policy only checked tenant_users directly without superadmin bypass or WITH CHECK clause.
-- This caused RLS violations when superadmins, newly created tenants, or backend ingest workers created campaigns.
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "campaigns_tenant_policy" ON campaigns;
CREATE POLICY "campaigns_tenant_policy" ON campaigns
    FOR ALL
    TO authenticated
    USING (
        -- User belongs to this tenant
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = campaigns.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        -- OR User is a SuperAdmin (via email or app_metadata)
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = campaigns.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    );

-- 2. Update leads RLS policy with matching SuperAdmin bypass and WITH CHECK
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "leads_tenant_policy" ON leads;
CREATE POLICY "leads_tenant_policy" ON leads
    FOR ALL
    TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = leads.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM tenant_users tu
            WHERE tu.tenant_id = leads.tenant_id
            AND tu.user_id = (SELECT auth.uid())
        )
        OR EXISTS (
            SELECT 1 FROM auth.users u
            WHERE u.id = (SELECT auth.uid())
            AND (
                u.raw_app_meta_data->>'is_super_admin' = 'true'
            )
        )
    );

COMMIT;
