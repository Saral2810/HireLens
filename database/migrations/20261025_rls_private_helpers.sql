-- ==============================================================================
-- Follow-up to 20261025_hr_screening_schema.sql (Supabase advisor fixes)
-- 1. RLS helper functions move to a "private" schema that the Data API does not expose,
--    so they cannot be called as /rest/v1/rpc/... endpoints.
-- 2. One SELECT policy per table (HR or own-record) plus HR-only write policies,
--    instead of two overlapping permissive SELECT policies.
-- ==============================================================================

CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon;
GRANT USAGE ON SCHEMA private TO authenticated;

CREATE OR REPLACE FUNCTION private.is_superadmin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'superadmin');
$$;

CREATE OR REPLACE FUNCTION private.my_candidate_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT id FROM public.candidates WHERE user_id = (SELECT auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION private.is_superadmin(), private.my_candidate_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_superadmin(), private.my_candidate_ids() TO authenticated;

-- Drop the first-version policies (they reference the public helpers).
DROP POLICY IF EXISTS profiles_select            ON public.profiles;
DROP POLICY IF EXISTS batches_hr_all             ON public.batches;
DROP POLICY IF EXISTS hr_questions_hr_all        ON public.hr_questions;
DROP POLICY IF EXISTS candidates_hr_all          ON public.candidates;
DROP POLICY IF EXISTS calls_hr_all               ON public.calls;
DROP POLICY IF EXISTS answers_hr_all             ON public.answers;
DROP POLICY IF EXISTS batches_candidate_read     ON public.batches;
DROP POLICY IF EXISTS candidates_candidate_read  ON public.candidates;
DROP POLICY IF EXISTS calls_candidate_read       ON public.calls;
DROP POLICY IF EXISTS answers_candidate_read     ON public.answers;
DROP POLICY IF EXISTS screening_files_hr_all          ON storage.objects;
DROP POLICY IF EXISTS screening_files_candidate_read  ON storage.objects;

DROP FUNCTION IF EXISTS public.is_superadmin();
DROP FUNCTION IF EXISTS public.my_candidate_ids();

-- ── Reads: HR sees everything; a candidate sees only their own records ──────
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR (SELECT private.is_superadmin()));

CREATE POLICY batches_read ON public.batches FOR SELECT TO authenticated
  USING ((SELECT private.is_superadmin())
         OR id IN (SELECT batch_id FROM public.candidates WHERE id IN (SELECT private.my_candidate_ids())));

CREATE POLICY hr_questions_read ON public.hr_questions FOR SELECT TO authenticated
  USING ((SELECT private.is_superadmin()));

CREATE POLICY candidates_read ON public.candidates FOR SELECT TO authenticated
  USING ((SELECT private.is_superadmin()) OR user_id = (SELECT auth.uid()));

CREATE POLICY calls_read ON public.calls FOR SELECT TO authenticated
  USING ((SELECT private.is_superadmin()) OR candidate_id IN (SELECT private.my_candidate_ids()));

CREATE POLICY answers_read ON public.answers FOR SELECT TO authenticated
  USING ((SELECT private.is_superadmin())
         OR call_id IN (SELECT id FROM public.calls WHERE candidate_id IN (SELECT private.my_candidate_ids())));

-- ── Writes: HR only (candidates change data only through the backend) ───────
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['batches', 'hr_questions', 'candidates', 'calls', 'answers'] LOOP
    EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO authenticated WITH CHECK ((SELECT private.is_superadmin()))', t || '_hr_insert', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR UPDATE TO authenticated USING ((SELECT private.is_superadmin())) WITH CHECK ((SELECT private.is_superadmin()))', t || '_hr_update', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR DELETE TO authenticated USING ((SELECT private.is_superadmin()))', t || '_hr_delete', t);
  END LOOP;
END $$;

-- ── Storage: same split ─────────────────────────────────────────────────────
CREATE POLICY screening_files_read ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id IN ('resumes', 'recordings')
    AND (
      (SELECT private.is_superadmin())
      OR EXISTS (
        SELECT 1 FROM public.candidates c
        WHERE c.user_id = (SELECT auth.uid())
          AND (storage.foldername(name))[1] = c.batch_id::text
          AND split_part(storage.filename(name), '.', 1) = c.id::text
      )
    )
  );
CREATE POLICY screening_files_hr_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('resumes', 'recordings') AND (SELECT private.is_superadmin()));
CREATE POLICY screening_files_hr_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id IN ('resumes', 'recordings') AND (SELECT private.is_superadmin()))
  WITH CHECK (bucket_id IN ('resumes', 'recordings') AND (SELECT private.is_superadmin()));
CREATE POLICY screening_files_hr_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id IN ('resumes', 'recordings') AND (SELECT private.is_superadmin()));
