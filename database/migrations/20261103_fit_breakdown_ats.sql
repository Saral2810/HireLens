-- ─── Fit score breakdown and ATS score ───────────────────────────────────────
-- calls.fit_breakdown: how the fit score was built (rubric version 2: four rated parts with a
--   reason each, the share of questions answered, and whether a steering cap applied).
-- candidates.ats_score / ats_breakdown: the resume's ATS score (0–100) and its five checks with tips,
--   computed when the resume is uploaded.
ALTER TABLE public.calls
  ADD COLUMN IF NOT EXISTS fit_breakdown jsonb;
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS ats_score smallint CHECK (ats_score IS NULL OR ats_score BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS ats_breakdown jsonb;
