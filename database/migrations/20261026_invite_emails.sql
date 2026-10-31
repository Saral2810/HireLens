-- ─── Invite emails ───────────────────────────────────────────────────────────
-- Running a campaign emails each candidate a personal link (sent from the app's own SMTP mailbox,
-- not Supabase). These columns show HR who was emailed and why an email failed.
ALTER TABLE public.candidates
  ADD COLUMN IF NOT EXISTS invite_email_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS invite_email_error text;
