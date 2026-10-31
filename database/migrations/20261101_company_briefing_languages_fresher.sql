-- ─── Company briefing, call languages, fresher flag ──────────────────────────
-- company_intro: HR's short intro about the company; the agent turns it into a spoken briefing.
-- call_languages: the languages candidates may pick for this campaign's calls
--   (mixed = English + Hindi, en = English, hi = Hindi).
-- is_fresher: read from the resume at upload (null = not known); freshers are not asked
--   notice period or current CTC.
ALTER TABLE public.batches
  ADD COLUMN IF NOT EXISTS company_intro text CHECK (company_intro IS NULL OR char_length(company_intro) <= 1500),
  ADD COLUMN IF NOT EXISTS call_languages text[] NOT NULL DEFAULT ARRAY['mixed', 'en', 'hi']
    CHECK (cardinality(call_languages) >= 1 AND call_languages <@ ARRAY['mixed', 'en', 'hi']);
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS is_fresher boolean;
