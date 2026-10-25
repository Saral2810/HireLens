-- Migration: 20261024_enable_rls_all_tables.sql
-- Security hardening. Earlier migrations DISABLE row level security on most tables, which in
-- Supabase lets anyone holding the publishable (anon) key read and write them through the Data API.
-- The backend only uses the service-role key (config/db.js), which bypasses RLS, so turning RLS on
-- with no extra policies closes the public API without changing app behaviour.

DO $$
DECLARE
    t RECORD;
BEGIN
    FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    END LOOP;
END $$;

-- Pin search_path on the dialer functions so a caller's search_path can't redirect them.
DO $$
DECLARE
    f RECORD;
BEGIN
    FOR f IN
        SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public'
          AND p.proname IN ('fn_dispatch_acquire', 'fn_dispatch_release', 'fn_reserve_slot', 'fn_release_slot',
                            'fn_reap_stranded_dispatches', 'fn_next_callable_slot', 'reap_stale_slots',
                            'trg_fn_schedule_retry', 'trg_fn_release_slot_on_call_session')
    LOOP
        EXECUTE format('ALTER FUNCTION public.%I(%s) SET search_path = public, pg_temp', f.proname, f.args);
    END LOOP;
END $$;
