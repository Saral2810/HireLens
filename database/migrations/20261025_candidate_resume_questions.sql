-- Phase F: questions written from the candidate's resume, and recording consent.
-- resume_questions: [{ "question_text": "...", "answer_type": "text" }, ...] written once after upload.
-- consent_at: when the candidate agreed to the call being recorded and transcribed.
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS resume_questions jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS consent_at timestamptz;
