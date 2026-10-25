-- ─── Roles and campaigns (UI rebuild) ─────────────────────────────────────────
-- Adds the Recruiter role and a campaign status (draft → live → closed) on batches,
-- and limits recruiters to the campaigns they created. Admin is the existing 'superadmin' role.
-- The backend (service role) checks the same rules in code; these policies are the safety net.

-- Roles: superadmin (shown as Admin), recruiter, candidate.
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check CHECK (role IN ('superadmin', 'recruiter', 'candidate'));

-- Campaign status. Existing batches were already in use, so they start live.
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft',
  ADD COLUMN IF NOT EXISTS launched_at timestamptz,
  ADD COLUMN IF NOT EXISTS closed_at timestamptz;
ALTER TABLE public.batches DROP CONSTRAINT IF EXISTS batches_status_check;
ALTER TABLE public.batches ADD CONSTRAINT batches_status_check CHECK (status IN ('draft', 'live', 'closed'));
UPDATE public.batches SET status = 'live', launched_at = COALESCE(launched_at, created_at) WHERE status = 'draft';
CREATE INDEX IF NOT EXISTS batches_created_by_idx ON public.batches (created_by);
CREATE INDEX IF NOT EXISTS candidates_email_idx ON public.candidates (email);

-- ── Helpers (private schema: not reachable through the Data API) ──
CREATE OR REPLACE FUNCTION private.is_hr()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role IN ('superadmin', 'recruiter'));
$$;

-- Admin manages every campaign; a recruiter only the campaigns they created.
CREATE OR REPLACE FUNCTION private.can_manage_batch(target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = (SELECT auth.uid())
      AND (p.role = 'superadmin'
           OR (p.role = 'recruiter' AND EXISTS (SELECT 1 FROM public.batches b WHERE b.id = target AND b.created_by = p.id)))
  );
$$;

-- Same check for a storage folder name (the batch id as text); never errors on other names.
CREATE OR REPLACE FUNCTION private.can_manage_folder(folder text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.batches b WHERE b.id::text = folder AND private.can_manage_batch(b.id));
$$;

REVOKE EXECUTE ON FUNCTION private.is_hr(), private.can_manage_batch(uuid), private.can_manage_folder(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.is_hr(), private.can_manage_batch(uuid), private.can_manage_folder(text) TO authenticated;

-- ── Policies: replace "is superadmin" with "can manage this campaign" ──
DROP POLICY IF EXISTS batches_read ON public.batches;
DROP POLICY IF EXISTS batches_hr_insert ON public.batches;
DROP POLICY IF EXISTS batches_hr_update ON public.batches;
DROP POLICY IF EXISTS batches_hr_delete ON public.batches;
CREATE POLICY batches_read ON public.batches FOR SELECT TO authenticated
  USING ((SELECT private.can_manage_batch(id))
         OR id IN (SELECT batch_id FROM public.candidates WHERE id IN (SELECT private.my_candidate_ids())));
CREATE POLICY batches_hr_insert ON public.batches FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_superadmin()) OR ((SELECT private.is_hr()) AND created_by = (SELECT auth.uid())));
CREATE POLICY batches_hr_update ON public.batches FOR UPDATE TO authenticated
  USING ((SELECT private.can_manage_batch(id))) WITH CHECK ((SELECT private.can_manage_batch(id)));
CREATE POLICY batches_hr_delete ON public.batches FOR DELETE TO authenticated
  USING ((SELECT private.can_manage_batch(id)));

DROP POLICY IF EXISTS hr_questions_read ON public.hr_questions;
DROP POLICY IF EXISTS hr_questions_hr_insert ON public.hr_questions;
DROP POLICY IF EXISTS hr_questions_hr_update ON public.hr_questions;
DROP POLICY IF EXISTS hr_questions_hr_delete ON public.hr_questions;
CREATE POLICY hr_questions_read ON public.hr_questions FOR SELECT TO authenticated USING ((SELECT private.can_manage_batch(batch_id)));
CREATE POLICY hr_questions_hr_insert ON public.hr_questions FOR INSERT TO authenticated WITH CHECK ((SELECT private.can_manage_batch(batch_id)));
CREATE POLICY hr_questions_hr_update ON public.hr_questions FOR UPDATE TO authenticated
  USING ((SELECT private.can_manage_batch(batch_id))) WITH CHECK ((SELECT private.can_manage_batch(batch_id)));
CREATE POLICY hr_questions_hr_delete ON public.hr_questions FOR DELETE TO authenticated USING ((SELECT private.can_manage_batch(batch_id)));

DROP POLICY IF EXISTS candidates_read ON public.candidates;
DROP POLICY IF EXISTS candidates_hr_insert ON public.candidates;
DROP POLICY IF EXISTS candidates_hr_update ON public.candidates;
DROP POLICY IF EXISTS candidates_hr_delete ON public.candidates;
CREATE POLICY candidates_read ON public.candidates FOR SELECT TO authenticated
  USING ((SELECT private.can_manage_batch(batch_id)) OR user_id = (SELECT auth.uid()));
CREATE POLICY candidates_hr_insert ON public.candidates FOR INSERT TO authenticated WITH CHECK ((SELECT private.can_manage_batch(batch_id)));
CREATE POLICY candidates_hr_update ON public.candidates FOR UPDATE TO authenticated
  USING ((SELECT private.can_manage_batch(batch_id))) WITH CHECK ((SELECT private.can_manage_batch(batch_id)));
CREATE POLICY candidates_hr_delete ON public.candidates FOR DELETE TO authenticated USING ((SELECT private.can_manage_batch(batch_id)));

DROP POLICY IF EXISTS calls_read ON public.calls;
DROP POLICY IF EXISTS calls_hr_insert ON public.calls;
DROP POLICY IF EXISTS calls_hr_update ON public.calls;
DROP POLICY IF EXISTS calls_hr_delete ON public.calls;
CREATE POLICY calls_read ON public.calls FOR SELECT TO authenticated
  USING (candidate_id IN (SELECT private.my_candidate_ids())
         OR candidate_id IN (SELECT c.id FROM public.candidates c WHERE (SELECT private.can_manage_batch(c.batch_id))));
CREATE POLICY calls_hr_insert ON public.calls FOR INSERT TO authenticated
  WITH CHECK (candidate_id IN (SELECT c.id FROM public.candidates c WHERE (SELECT private.can_manage_batch(c.batch_id))));
CREATE POLICY calls_hr_update ON public.calls FOR UPDATE TO authenticated
  USING (candidate_id IN (SELECT c.id FROM public.candidates c WHERE (SELECT private.can_manage_batch(c.batch_id))))
  WITH CHECK (candidate_id IN (SELECT c.id FROM public.candidates c WHERE (SELECT private.can_manage_batch(c.batch_id))));
CREATE POLICY calls_hr_delete ON public.calls FOR DELETE TO authenticated
  USING (candidate_id IN (SELECT c.id FROM public.candidates c WHERE (SELECT private.can_manage_batch(c.batch_id))));

DROP POLICY IF EXISTS answers_read ON public.answers;
DROP POLICY IF EXISTS answers_hr_insert ON public.answers;
DROP POLICY IF EXISTS answers_hr_update ON public.answers;
DROP POLICY IF EXISTS answers_hr_delete ON public.answers;
CREATE POLICY answers_read ON public.answers FOR SELECT TO authenticated
  USING (call_id IN (SELECT k.id FROM public.calls k WHERE k.candidate_id IN (SELECT private.my_candidate_ids()))
         OR call_id IN (SELECT k.id FROM public.calls k JOIN public.candidates c ON c.id = k.candidate_id WHERE (SELECT private.can_manage_batch(c.batch_id))));
CREATE POLICY answers_hr_insert ON public.answers FOR INSERT TO authenticated
  WITH CHECK (call_id IN (SELECT k.id FROM public.calls k JOIN public.candidates c ON c.id = k.candidate_id WHERE (SELECT private.can_manage_batch(c.batch_id))));
CREATE POLICY answers_hr_update ON public.answers FOR UPDATE TO authenticated
  USING (call_id IN (SELECT k.id FROM public.calls k JOIN public.candidates c ON c.id = k.candidate_id WHERE (SELECT private.can_manage_batch(c.batch_id))))
  WITH CHECK (call_id IN (SELECT k.id FROM public.calls k JOIN public.candidates c ON c.id = k.candidate_id WHERE (SELECT private.can_manage_batch(c.batch_id))));
CREATE POLICY answers_hr_delete ON public.answers FOR DELETE TO authenticated
  USING (call_id IN (SELECT k.id FROM public.calls k JOIN public.candidates c ON c.id = k.candidate_id WHERE (SELECT private.can_manage_batch(c.batch_id))));

-- Profiles: own row; Admin reads all (Team page). Nobody edits roles through the API.
DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR (SELECT private.is_superadmin()));

-- Storage: HR reach files of campaigns they manage; candidates their own (unchanged rule).
DROP POLICY IF EXISTS screening_files_read ON storage.objects;
DROP POLICY IF EXISTS screening_files_hr_insert ON storage.objects;
DROP POLICY IF EXISTS screening_files_hr_update ON storage.objects;
DROP POLICY IF EXISTS screening_files_hr_delete ON storage.objects;
CREATE POLICY screening_files_read ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id IN ('resumes', 'recordings') AND (
    (SELECT private.can_manage_folder((storage.foldername(name))[1]))
    OR EXISTS (SELECT 1 FROM public.candidates c
               WHERE c.user_id = (SELECT auth.uid())
                 -- objects.name, not c.name: an unqualified "name" here means the candidate's name.
                 AND (storage.foldername(objects.name))[1] = c.batch_id::text
                 -- <candidate>.pdf (resume) or <candidate>-<call>.<ext> (recording)
                 AND storage.filename(objects.name) LIKE c.id::text || '%')));
CREATE POLICY screening_files_hr_insert ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id IN ('resumes', 'recordings') AND (SELECT private.can_manage_folder((storage.foldername(name))[1])));
CREATE POLICY screening_files_hr_update ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id IN ('resumes', 'recordings') AND (SELECT private.can_manage_folder((storage.foldername(name))[1])))
  WITH CHECK (bucket_id IN ('resumes', 'recordings') AND (SELECT private.can_manage_folder((storage.foldername(name))[1])));
CREATE POLICY screening_files_hr_delete ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id IN ('resumes', 'recordings') AND (SELECT private.can_manage_folder((storage.foldername(name))[1])));
