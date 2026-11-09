-- ─── Workspaces ──────────────────────────────────────────────────────────────
-- Each HR team works in its own workspace: its campaigns, candidates, results and team are visible
-- only inside it. The existing team becomes the 'main' workspace, with no limits. People who sign up
-- through the sign-up link get a new 'demo' workspace with usage limits, as an HR lead.
--
-- Roles (profiles.role):
--   superadmin  Admin of their workspace: every campaign in it, manages its team (Admins and Recruiters)
--   hr_lead     leads a sign-up workspace: every campaign in it, adds and removes Recruiters only
--   recruiter   only the campaigns they created
--   candidate   only their own screening
-- Nobody reaches another workspace. The backend (service role) checks the same rules in code;
-- these policies are the safety net.

-- ── 1. Workspaces ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.workspaces (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                        text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  kind                        text NOT NULL DEFAULT 'demo' CHECK (kind IN ('main', 'demo')),
  -- Usage limits; NULL = no limit (the main workspace has none).
  max_campaigns               integer CHECK (max_campaigns IS NULL OR max_campaigns >= 0),
  max_candidates_per_campaign integer CHECK (max_candidates_per_campaign IS NULL OR max_candidates_per_campaign >= 0),
  max_completed_calls         integer CHECK (max_completed_calls IS NULL OR max_completed_calls >= 0),
  max_members                 integer CHECK (max_members IS NULL OR max_members >= 0),
  max_emails_per_day          integer CHECK (max_emails_per_day IS NULL OR max_emails_per_day >= 0),
  created_by                  uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

-- The existing team's workspace. Its id is fixed so the backend can name it.
INSERT INTO public.workspaces (id, name, kind)
VALUES ('00000000-0000-0000-0000-000000000001', 'Main workspace', 'main')
ON CONFLICT (id) DO NOTHING;

-- ── 2. Profiles and campaigns belong to a workspace ───────────────────────────
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_role_check
  CHECK (role IN ('superadmin', 'hr_lead', 'recruiter', 'candidate'));

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE SET NULL;
UPDATE public.profiles SET workspace_id = '00000000-0000-0000-0000-000000000001'
WHERE role IN ('superadmin', 'recruiter') AND workspace_id IS NULL;

ALTER TABLE public.batches ADD COLUMN IF NOT EXISTS workspace_id uuid REFERENCES public.workspaces(id) ON DELETE CASCADE;
UPDATE public.batches SET workspace_id = '00000000-0000-0000-0000-000000000001' WHERE workspace_id IS NULL;
ALTER TABLE public.batches ALTER COLUMN workspace_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS profiles_workspace_idx ON public.profiles (workspace_id);
CREATE INDEX IF NOT EXISTS batches_workspace_idx ON public.batches (workspace_id);

-- ── 3. Helpers (private schema: not reachable through the Data API) ───────────
CREATE OR REPLACE FUNCTION private.my_workspace_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT workspace_id FROM public.profiles
  WHERE id = (SELECT auth.uid()) AND role IN ('superadmin', 'hr_lead', 'recruiter');
$$;

-- Admin or HR lead: manages everything inside their own workspace.
CREATE OR REPLACE FUNCTION private.is_workspace_manager()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role IN ('superadmin', 'hr_lead'));
$$;

CREATE OR REPLACE FUNCTION private.is_hr()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role IN ('superadmin', 'hr_lead', 'recruiter'));
$$;

-- A campaign is reachable only inside the user's own workspace: managers reach all of it,
-- a recruiter only the campaigns they created.
CREATE OR REPLACE FUNCTION private.can_manage_batch(target uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles p
    JOIN public.batches b ON b.id = target
    WHERE p.id = (SELECT auth.uid())
      AND p.workspace_id IS NOT NULL
      AND b.workspace_id = p.workspace_id
      AND (p.role IN ('superadmin', 'hr_lead') OR (p.role = 'recruiter' AND b.created_by = p.id))
  );
$$;

REVOKE EXECUTE ON FUNCTION private.my_workspace_id(), private.is_workspace_manager(), private.is_hr(), private.can_manage_batch(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.my_workspace_id(), private.is_workspace_manager(), private.is_hr(), private.can_manage_batch(uuid) TO authenticated;

-- ── 4. Policies that used to reach every workspace ────────────────────────────
-- Old policies from earlier migrations, in case any remain on a project.
DROP POLICY IF EXISTS profiles_select ON public.profiles;
DROP POLICY IF EXISTS hr_questions_hr_all ON public.hr_questions;
DROP POLICY IF EXISTS screening_files_hr_all ON storage.objects;

-- New campaigns go only into the creator's own workspace.
DROP POLICY IF EXISTS batches_hr_insert ON public.batches;
CREATE POLICY batches_hr_insert ON public.batches FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.is_hr()) AND created_by = (SELECT auth.uid()) AND workspace_id = (SELECT private.my_workspace_id()));

-- Everyone reads their own profile; Admins and HR leads read their own workspace's team.
DROP POLICY IF EXISTS profiles_read ON public.profiles;
CREATE POLICY profiles_read ON public.profiles FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid())
         OR ((SELECT private.is_workspace_manager()) AND workspace_id = (SELECT private.my_workspace_id())));

-- Workspaces: HR reads only their own. Only the backend creates or changes them.
ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspaces_read ON public.workspaces;
CREATE POLICY workspaces_read ON public.workspaces FOR SELECT TO authenticated
  USING (id = (SELECT private.my_workspace_id()));
