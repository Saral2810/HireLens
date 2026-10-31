-- ─── Campaign scheduling, general call questions ─────────────────────────────
-- scheduled_at: a draft campaign starts by itself at this time and emails every candidate then.
-- closes_at: a live campaign closes by itself at this time.
-- answers.source 'general': the project and problem questions every call asks (and the
--   "full-time experience or fresher?" check), between the opening and the resume questions.
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS closes_at timestamptz;
CREATE INDEX IF NOT EXISTS batches_scheduled_at_idx ON public.batches (scheduled_at) WHERE status = 'draft' AND scheduled_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS batches_closes_at_idx ON public.batches (closes_at) WHERE status = 'live' AND closes_at IS NOT NULL;

ALTER TABLE public.answers DROP CONSTRAINT IF EXISTS answers_source_check;
ALTER TABLE public.answers ADD CONSTRAINT answers_source_check CHECK (source IN ('intro', 'general', 'resume', 'hr'));
