-- ==============================================================================
-- HR Screening Voice Agent — schema (roadmap Phase C)
-- Run on the contest project only.
-- ==============================================================================

-- ── 1. Tables ───────────────────────────────────────────────────────────────

-- One row per signed-in user (HR or candidate). Created automatically from auth.users.
CREATE TABLE public.profiles (
  id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name        text,
  email       text NOT NULL,
  role        text NOT NULL DEFAULT 'candidate' CHECK (role IN ('superadmin', 'candidate')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- A group of candidates screened for one role, e.g. "Batch 1 – 24 Oct".
CREATE TABLE public.batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  batch_date       date NOT NULL DEFAULT current_date,
  job_role         text NOT NULL,
  job_description  text,
  company_name     text,
  created_by       uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- HR's fixed questions for a batch, asked after the resume questions.
CREATE TABLE public.hr_questions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id       uuid NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
  question_text  text NOT NULL,
  position       integer NOT NULL CHECK (position >= 0),
  answer_type    text NOT NULL DEFAULT 'text' CHECK (answer_type IN ('text', 'number', 'yes_no', 'ctc', 'duration')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Deferrable so a reorder can swap positions inside one transaction.
  CONSTRAINT hr_questions_batch_position_key UNIQUE (batch_id, position) DEFERRABLE INITIALLY DEFERRED
);

-- A candidate invited to one batch. user_id is set once they sign in through the invite link.
CREATE TABLE public.candidates (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id        uuid NOT NULL REFERENCES public.batches(id) ON DELETE CASCADE,
  user_id         uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  name            text NOT NULL,
  email           text NOT NULL,
  resume_path     text,
  resume_text     text,
  status          text NOT NULL DEFAULT 'invited'
                  CHECK (status IN ('invited', 'resume_uploaded', 'in_call', 'completed', 'failed')),
  failure_reason  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT candidates_batch_email_key UNIQUE (batch_id, email)
);

-- One screening call. question_plan is saved before the call starts, so every call is repeatable.
CREATE TABLE public.calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  candidate_id    uuid NOT NULL REFERENCES public.candidates(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed', 'failed')),
  question_plan   jsonb NOT NULL DEFAULT '[]'::jsonb,
  transcript      jsonb NOT NULL DEFAULT '[]'::jsonb,
  recording_path  text,
  summary         text,
  fit_score       integer CHECK (fit_score BETWEEN 0 AND 100),
  failure_reason  text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  ended_at        timestamptz
);

-- One answer to one question in a call.
CREATE TABLE public.answers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id          uuid NOT NULL REFERENCES public.calls(id) ON DELETE CASCADE,
  position         integer NOT NULL CHECK (position >= 0),
  question_text    text NOT NULL,
  source           text NOT NULL CHECK (source IN ('intro', 'resume', 'hr')),
  answer_type      text NOT NULL DEFAULT 'text' CHECK (answer_type IN ('text', 'number', 'yes_no', 'ctc', 'duration')),
  answer_text      text,
  extracted_value  jsonb,
  outcome          text NOT NULL DEFAULT 'answered' CHECK (outcome IN ('answered', 'skipped')),
  attempts         integer NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT answers_call_position_key UNIQUE (call_id, position)
);

-- Usage log of every Prisma / Timbre / LLM request (written by the backend only).
CREATE TABLE public.external_call_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service          text NOT NULL,
  endpoint         text NOT NULL,
  method           text NOT NULL,
  request_id       text NOT NULL,
  session_id       text,
  payload          jsonb,
  response_status  integer,
  response_body    jsonb,
  duration_ms      integer,
  error            text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX hr_questions_batch_idx       ON public.hr_questions (batch_id);
CREATE INDEX candidates_batch_status_idx  ON public.candidates (batch_id, status);
CREATE INDEX candidates_user_idx          ON public.candidates (user_id);
CREATE INDEX calls_candidate_idx          ON public.calls (candidate_id);
CREATE INDEX answers_call_idx             ON public.answers (call_id);
CREATE INDEX batches_created_by_idx       ON public.batches (created_by);
CREATE INDEX external_call_logs_session_idx ON public.external_call_logs (session_id, created_at);

-- ── 2. updated_at bookkeeping ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER batches_set_updated_at    BEFORE UPDATE ON public.batches    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER candidates_set_updated_at BEFORE UPDATE ON public.candidates FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── 3. Profiles from auth users ─────────────────────────────────────────────
-- Role comes from app metadata (set only by the server): is_super_admin=true or role=superadmin.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name, role)
  VALUES (
    NEW.id,
    coalesce(NEW.email, ''),
    NEW.raw_user_meta_data ->> 'name',
    CASE WHEN NEW.raw_app_meta_data ->> 'is_super_admin' = 'true' OR NEW.raw_app_meta_data ->> 'role' = 'superadmin'
         THEN 'superadmin' ELSE 'candidate' END
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Users that already exist (e.g. the HR super-admin).
INSERT INTO public.profiles (id, email, name, role)
SELECT u.id, coalesce(u.email, ''), u.raw_user_meta_data ->> 'name',
       CASE WHEN u.raw_app_meta_data ->> 'is_super_admin' = 'true' OR u.raw_app_meta_data ->> 'role' = 'superadmin'
            THEN 'superadmin' ELSE 'candidate' END
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- ── 4. Row Level Security ───────────────────────────────────────────────────
-- The backend uses the service-role key (bypasses RLS) and checks access in code too.
-- These rules are the second safety net for anything using a user's own session.

CREATE OR REPLACE FUNCTION public.is_superadmin()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = (SELECT auth.uid()) AND role = 'superadmin');
$$;

-- Candidate rows that belong to the signed-in user.
CREATE OR REPLACE FUNCTION public.my_candidate_ids()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT id FROM public.candidates WHERE user_id = (SELECT auth.uid());
$$;

REVOKE EXECUTE ON FUNCTION public.is_superadmin(), public.my_candidate_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_superadmin(), public.my_candidate_ids() TO authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user(), public.set_updated_at() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.profiles           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.batches            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hr_questions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.candidates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calls              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.answers            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.external_call_logs ENABLE ROW LEVEL SECURITY;  -- no policies: backend only

-- profiles: everyone reads their own; HR reads all. Nobody edits roles through the API.
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()) OR (SELECT public.is_superadmin()));

-- HR manages batches, questions, candidates, calls and answers.
CREATE POLICY batches_hr_all      ON public.batches      FOR ALL TO authenticated USING ((SELECT public.is_superadmin())) WITH CHECK ((SELECT public.is_superadmin()));
CREATE POLICY hr_questions_hr_all ON public.hr_questions FOR ALL TO authenticated USING ((SELECT public.is_superadmin())) WITH CHECK ((SELECT public.is_superadmin()));
CREATE POLICY candidates_hr_all   ON public.candidates   FOR ALL TO authenticated USING ((SELECT public.is_superadmin())) WITH CHECK ((SELECT public.is_superadmin()));
CREATE POLICY calls_hr_all        ON public.calls        FOR ALL TO authenticated USING ((SELECT public.is_superadmin())) WITH CHECK ((SELECT public.is_superadmin()));
CREATE POLICY answers_hr_all      ON public.answers      FOR ALL TO authenticated USING ((SELECT public.is_superadmin())) WITH CHECK ((SELECT public.is_superadmin()));

-- Candidates may only READ their own records; every change goes through the backend.
CREATE POLICY batches_candidate_read ON public.batches FOR SELECT TO authenticated
  USING (id IN (SELECT batch_id FROM public.candidates WHERE id IN (SELECT public.my_candidate_ids())));
CREATE POLICY candidates_candidate_read ON public.candidates FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
CREATE POLICY calls_candidate_read ON public.calls FOR SELECT TO authenticated
  USING (candidate_id IN (SELECT public.my_candidate_ids()));
CREATE POLICY answers_candidate_read ON public.answers FOR SELECT TO authenticated
  USING (call_id IN (SELECT id FROM public.calls WHERE candidate_id IN (SELECT public.my_candidate_ids())));

-- ── 5. Private storage ──────────────────────────────────────────────────────
-- resumes/<batch-id>/<candidate-id>.pdf     recordings/<batch-id>/<candidate-id>.webm
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES
  ('resumes',    'resumes',    false, 5242880,  ARRAY['application/pdf']),
  ('recordings', 'recordings', false, 52428800, ARRAY['audio/webm', 'audio/ogg', 'audio/wav', 'audio/mpeg'])
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public, file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY screening_files_hr_all ON storage.objects FOR ALL TO authenticated
  USING (bucket_id IN ('resumes', 'recordings') AND (SELECT public.is_superadmin()))
  WITH CHECK (bucket_id IN ('resumes', 'recordings') AND (SELECT public.is_superadmin()));

-- Candidates read their own files only (uploads use signed URLs issued by the backend).
CREATE POLICY screening_files_candidate_read ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id IN ('resumes', 'recordings')
    AND EXISTS (
      SELECT 1 FROM public.candidates c
      WHERE c.user_id = (SELECT auth.uid())
        AND (storage.foldername(name))[1] = c.batch_id::text
        AND split_part(storage.filename(name), '.', 1) = c.id::text
    )
  );
