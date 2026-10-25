# HR Screening Voice Agent

A web app where a candidate logs in, uploads a resume, and takes a short voice screening call with an AI agent **in the browser**. No phone number is needed. HR creates batches of candidates, sets the job role and fixed questions, and reviews every candidate's answers, transcript and recording.

Built for the Gnani AI "Great Indian AI Internship Challenge" on Gnani's own models:

| Part | Model |
|---|---|
| Speech to text | Gnani **Prisma v2.5** |
| Text to speech | Gnani **Timbre v2.5** |
| Brain | Gnani **Evon v3.3** (self-hosted), or a backup LLM through the same `.env` slot |

> **Status:** being rebuilt from the legacy voice-campaign platform. Phase A (clean-up) is done; the plan of record is `HR_Screening_Roadmap_v3.docx`.

## Run it

```bash
cp .env.example .env          # fill in Supabase, Gnani and LLM settings
npm install && npm run build  # install + build the web UI
npm start                     # open http://localhost:3000
```

UI development with hot reload: run `npm run dev` and `npm run client:dev` in two terminals, then open http://localhost:5173.

Tests: `npm test`

## How it is put together

```
Candidate browser ⇄ Backend (Node/Express) ⇄ Gnani Prisma (voice → text)
                                            ⇄ Brain: Evon or backup LLM
                                            ⇄ Gnani Timbre (text → voice)
                         └─► Supabase (tables + private storage)
HR browser ⇄ Backend ⇄ Supabase (batch results, signed recording links)
```

All keys stay on the backend. The browser only holds the signed-in user's session.

## Folder map

```
backend/src/
  app.js, server.js          server wiring, login, health
  config/db.js               Supabase client (service role, no stored sessions)
  middleware/auth.js         requireAuth + requireRole('superadmin' | 'candidate')
  services/llmService.js     the brain slot (any OpenAI-compatible API)
  services/observability/    logs every external call (for credit tracking)
  utils/validation.js        parsing spoken answers (notice period, amounts)
client/                      React + Vite web app
database/                    schema (Phase C); legacy/ holds the old legacy schema
tests/                       unit tests
```

## Data rules for the contest

Use made-up candidates and resumes only. Record only your own voice or a teammate who agrees. Name every Gnani model used in the submission.
