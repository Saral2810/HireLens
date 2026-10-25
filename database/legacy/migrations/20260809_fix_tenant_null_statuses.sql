-- Migration: Fix tenant management system bugs
-- Date: 2026-08-09
-- Description:
--   1. Set all NULL tenant statuses to 'active' so that PostgREST .neq('status','deleted')
--      queries work correctly (NULL rows are silently excluded by .neq() in PostgREST).
--   2. Document the enabled_features convention:
--      NULL = full access (all features enabled)
--      JSON array = restrict to those features only

-- Fix: Normalize all NULL statuses to 'active'
UPDATE tenant_configs
SET status = 'active'
WHERE status IS NULL;

-- Verify
-- SELECT tenant_id, name, status FROM tenant_configs ORDER BY created_at;
