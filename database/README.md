# Database (Supabase)

## Set up a new project

1. Create a Supabase project for the contest (never a work database).
2. **SQL Editor** → paste all of `setup.sql` → **Run**.
3. **Authentication → Users → Add user** for the HR login (tick *Auto Confirm User*), then make it HR:

```sql
UPDATE auth.users SET raw_app_meta_data = raw_app_meta_data || '{"is_super_admin": true}' WHERE email = 'you@example.com';
UPDATE public.profiles SET role = 'superadmin' WHERE email = 'you@example.com';
```

4. Put the project URL and service-role key in `.env`, and the same email in `SUPER_ADMIN_EMAILS`.

## What is inside

| Table | One row is… |
|---|---|
| `profiles` | one signed-in user; `role` is `superadmin` (HR) or `candidate`. Created automatically when an auth user is created |
| `batches` | one batch, e.g. "Batch 1 – 24 Oct", with the job role |
| `hr_questions` | one fixed HR question in a batch (`position`, `answer_type`) |
| `candidates` | one invited candidate (name, email, resume, `status`: invited → resume_uploaded → in_call → completed / failed) |
| `calls` | one screening call: saved question plan, transcript, recording path, summary, fit score |
| `answers` | one answer to one question: text, extracted value, attempts |
| `external_call_logs` | usage log of every Prisma / Timbre / LLM request (backend only) |

Private storage buckets: `resumes/<batch-id>/<candidate-id>.pdf` (PDF, 5 MB) and `recordings/<batch-id>/<candidate-id>.webm` (50 MB). HR plays recordings through short-lived signed links.

## Access rules (Row Level Security)

- **HR (`superadmin`)** reads and writes everything.
- **Candidates** can only **read** their own candidate row, call, answers, batch and files. Every change goes through the backend.
- **Not signed in**: nothing.
- Helper functions live in the `private` schema, which the Data API does not expose.

The backend uses the service-role key (which bypasses these rules) and also checks access in code; RLS is the second safety net.

## Files

- `setup.sql`: everything above in one file.
- `migrations/`: the same SQL as applied, in order.
- `legacy/`: the old legacy schema, for reference only. Do not run it.
