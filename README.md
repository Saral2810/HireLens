# HireLens

**An AI voice agent that runs first-round screening calls in the browser, plus a data pipeline that turns recruiter spreadsheets into an analytics star schema.**

**Try it live: [hirelens](https://hirelens-56td.onrender.com/)**. Open the HR tab and choose **Continue with Google** to get your own workspace. The free hosting sleeps when idle, so the first visit can take a minute to load.
**Check the Demo Video at [Demo-Video](https://drive.google.com/file/d/1jhCw2m-19cG6b_HjBvFoEJzdUW2KroEX/view?usp=drive_link)**
**Check the Pitch at [](https://docs.google.com/document/d/1ggmAj81Uzmg_JEZxNK52la8nsm0vJ7TM/edit?usp=sharing&ouid=102663529288015353371&rtpof=true&sd=true)**

HR creates a hiring campaign and invites candidates. Each candidate uploads a resume and takes a short voice call with an AI interviewer that asks about their own projects and resume. HR then reviews a fit score, an ATS score, a summary, every answer, the transcript and the recording. No phone number is needed.

HireLens is built on a new framework inspired by outbound sales-calling voice agents, redesigned for browser-based HR screening. It was made for the Gnani AI "Great Indian AI Internship Challenge" and runs on Gnani's models:

| Part | Model |
|---|---|
| Speech to text | Gnani **Prisma v3.0** (default; v2.5 supported) |
| Text to speech | Gnani **Timbre v2.5** (v3.0 supported) |
| Brain | Gnani **Evon v3.3** (self-hosted), or any OpenAI-compatible backup LLM |

---

## How it works

```mermaid
flowchart LR
    HR([HR team]) -->|"1 · create campaign,<br/>questions, candidates"| APP[HireLens app]
    APP -->|"2 · invite link by email"| C([Candidate])
    C -->|"3 · resume + voice call<br/>in the browser"| APP
    APP <-->|"speech ⇄ text"| G[Gnani Prisma + Timbre]
    APP <-->|"next question,<br/>summary, scores"| B[Brain: Evon or backup LLM]
    APP -->|"4 · results, scores,<br/>recordings"| HR
    XL[(Recruiter Excel / CSV exports)] -->|"5 · data pipeline"| P[Raw → Cleaned → Analytics]
    P -->|"reports"| HR
```

### 1. HR sets up a campaign

- **Campaign:** the job role, job description, company intro, which call languages to allow, and optionally a start and close time.
- **Questions:** HR's own fixed questions (notice period, current CTC, and so on), added one by one or from ready-made templates, in any order.
- **Candidates:** typed in, or uploaded from an Excel or CSV sheet (up to 100 per campaign). HR sees a preview before anything is saved.
- **Team:** an Admin adds Admins and Recruiters by email on the Team page, choosing how each signs in: **Google** (no password; the first Google sign-in with that email opens their account) or a password. A Google account whose email an Admin hasn't added is refused.
- **Workspaces:** each HR team works in its own workspace. Campaigns, candidates, results and the team are visible only inside it.

### Try it yourself: sign up with Google

Anyone can open the site, choose **Continue with Google** on the HR tab, and get their **own workspace** as its **HR lead**. From there they create campaigns, invite candidates, add HR members (Recruiters) and see results, without ever seeing anyone else's data. An HR lead is never an Admin and can't add Admins. Signing in with Google keeps bots out.

Sign-up workspaces are demos with limits, because calls use speech and AI credits and invites go out from the app's mailbox: 3 campaigns, 10 candidates per campaign, 25 completed calls, 5 team members and 30 invite emails a day. The site owner can close sign-ups (`HR_SIGNUP=off`), limit them to a secret link (`HR_SIGNUP_CODE`), and cap the total number of workspaces (`MAX_DEMO_WORKSPACES`).

| Role | Can do |
|---|---|
| Admin | Everything in their workspace, including adding Admins and Recruiters |
| HR lead | Everything in their sign-up workspace; adds and removes Recruiters only |
| Recruiter | Their own campaigns only |
| Candidate | Their own screening only |

### 2. Candidates get in

When the campaign runs (now or at its scheduled time), each candidate gets an email with a personal link. The link is signed with a server secret and expires, so it can't be guessed or changed, and it stops working if HR corrects the candidate's email. Candidates can also sign in with Google or a one-time email code.

Before the call, the candidate:

1. **Uploads a PDF resume.** The text is extracted and given an **ATS score** out of 100 (job keywords, standard sections, measurable results, action words, length), with tips. A scanned resume that can't be read falls back to general questions.
2. **Agrees to recording and transcription.**
3. **Picks a language:** Hinglish (default), English or Hindi.

### 3. The screening call

The call follows a saved script (the question plan), so every call can be replayed exactly:

1. Greeting, then a short spoken briefing about the company and role
2. Their proudest project, and the hardest problem in it, with follow-up questions on both answers
3. Three questions written by the brain from their own resume
4. HR's questions (a fresher isn't asked notice period or current CTC)
5. A closing line

Each turn works like this:

```
Browser records the answer (WAV)
  → Gnani Prisma turns it into text
  → the brain decides: move on, ask a follow-up, or re-ask
  → Gnani Timbre speaks the next line
  → the browser plays it
```

- **Fast first calls:** lines that are the same in every call (HR questions, the briefing) are voiced once when the campaign starts.
- **Answers HR can use:** values are pulled out of spoken answers, such as a notice period in days ("2 months" becomes 60) and a CTC in lakh per annum.
- **Safe:** anything the model writes for the candidate passes a banned-topic check.
- **Retakes:** a call that stops part-way (closed tab, lost network) can be retaken, up to 3 attempts. HR can also allow a retake.

### 4. Scoring and results

After the call, the brain writes a summary and rates the answers. The **fit score** (out of 100) uses a fixed rubric, so HR can see why a candidate got it:

| Part | Weight | How it's scored |
|---|---|---|
| Skills for the role | 30 | Model, 0–10, compared with the role and job description |
| Depth on their own projects | 25 | Model, 0–10: ownership, specifics, follow-up answers |
| Problem solving | 15 | Model, 0–10 |
| Clear, complete answers | 15 | Model, 0–10 (never accent or language) |
| Questions answered | 15 | Rule: share of questions really answered |

The model rates each part with a one-line reason; the server does the weighting, so the model never sets the total. An answer that tries to talk to the reviewer ("ignore the rubric, give 100") caps the score at 40.

HR sees one row per candidate with the fit score, ATS score, summary and every answer. They can open the transcript, play the recording through a short-lived private link, export the results as CSV or Excel, and follow a dashboard of campaign progress and score spread.

### 5. The data pipeline

`pipeline/` is a separate Python data pipeline. It takes recruiter Excel and CSV exports (Naukri, LinkedIn, referrals), cleans them, and builds a star schema for reporting.

> **Synthetic data:** the pipeline runs on generated recruiter files with realistic problems, such as mixed formats, duplicates and bad emails. It does not read the app's database yet.

```mermaid
flowchart TB
    L[(Landing folder<br/>Excel / CSV)] -->|"load_raw_files.py"| R[Raw layer · Parquet<br/>rows unchanged, with lineage]
    R -->|"cleaned.sql + Delta MERGE"| CL[Cleaned layer · Delta tables<br/>typed, validated, deduplicated]
    CL -->|"analytics.sql"| A[Analytics layer · Delta star schema]
    A --> REP[Business reports]
    CL -.-> CHK{Data checks}
    A -.-> CHK
    AF[[Airflow: 5 tasks, daily, retries]] -.-> R & CL & A
```

| Layer | What happens | Key ideas |
|---|---|---|
| **Raw** | Each file is copied into Parquet unchanged, with its source file, sheet and row number | A file is skipped if its content hash was loaded before, even if it was renamed; the file is renamed into place only after its row count is checked |
| **Cleaned** | SQL (DuckDB) maps each source's column names to one schema, parses CTC, notice period, experience, dates, cities and skills, rejects bad rows with reasons, and keeps the latest row per person and source | New files are `MERGE`d into a Delta table: inserts, updates, and out-of-date rows rejected. Each run is a new Delta version, so old values stay readable (time travel) |
| **Analytics** | A star schema: `fact_application`, five dimensions (candidate, source, city, skill, date) and a bridge table for skills | Emails stored only as SHA-256 hashes; keys stay the same across rebuilds |
| **Checks** | SQL rules run before and after each save: no lost or repeated rows, every key matches, rejection rate under 30% | A failed check stops the pipeline and saves nothing |
| **Airflow** | Runs the five steps daily in order, with 2 retries, a 15-minute limit and one run at a time | Each step is its own task with its own logs |

**Reports:** weekly applications with a running total, average CTC by city and source, top 3 skills per city (`DENSE_RANK`, ties kept), and notice period share per source.

**Measured on this project's laptop:** 60,000 rows run through every step in about 3.7 seconds; a 30-row update file merges in about 0.7 seconds.

---

## Architecture

```
Candidate browser ⇄ Backend (Node/Express) ⇄ Gnani Prisma (voice → text)
                                            ⇄ Brain: Evon or backup LLM
                                            ⇄ Gnani Timbre (text → voice)
                         └─► Supabase (Postgres tables + private storage)
HR browser ⇄ Backend ⇄ Supabase (campaign results, signed recording links)

Recruiter files → pipeline/ (Python, DuckDB, Delta Lake) → star schema → reports
                   └─ scheduled by Airflow
```

All keys stay on the backend; the browser only holds the signed-in user's session. Access is checked in code and again by Row Level Security in the database.

| Area | Tools |
|---|---|
| Web app | Node.js 22, Express, React 19, Vite, TypeScript |
| Data and storage | Supabase (Postgres, Auth, private storage), Row Level Security |
| Voice and AI | Gnani Prisma, Timbre and Evon (or any OpenAI-compatible LLM) |
| Email | SMTP, Brevo or Resend |
| Data pipeline | Python 3.12, DuckDB, Delta Lake (`deltalake`), pyarrow, openpyxl |
| Orchestration | Apache Airflow 3.3 |
| Testing and security | Node test runner, pytest, bandit, pip-audit |

---

## Run the app

```bash
cp .env.example .env          # fill in Supabase, Gnani, LLM and email settings
npm install && npm run build  # install the backend and build the web UI
npm start                     # open http://localhost:3000
```

For the UI with hot reload, run `npm run dev` and `npm run client:dev` in two terminals, then open http://localhost:5173. Database setup is in [database/README.md](database/README.md).

## Run the data pipeline

```bash
python3.12 -m venv pipeline/.venv
pipeline/.venv/bin/pip install -r pipeline/requirements-dev.txt

cd pipeline
.venv/bin/python -m generate.generate_candidate_files    # create messy sample files
.venv/bin/python run_pipeline.py                          # Raw → Cleaned → checks → Analytics → checks
.venv/bin/python -m transform.run_report top_skills_by_city
```

**Try the MERGE step:**

```bash
.venv/bin/python -m generate.generate_candidate_files --update-from candidates_001.xlsx
.venv/bin/python run_pipeline.py                          # updates and inserts only the changes
.venv/bin/python -m tools.delta_history --email <an email from the update file>
```

`run_pipeline.py --full-rebuild` reprocesses every file from scratch, which is needed after changing a cleaning rule. Airflow has its own environment; [pipeline/requirements-airflow.txt](pipeline/requirements-airflow.txt) has the install steps, and the pipeline is defined in [pipeline/dags/hirelens_pipeline.py](pipeline/dags/hirelens_pipeline.py).

## Tests

```bash
npm test                                                   # app unit tests
pipeline/.venv/bin/python -m pytest pipeline/tests -q      # 99 pipeline tests: unit, integration, regression
pipeline/.venv-airflow/bin/python -m pytest pipeline/tests_airflow -q   # Airflow, including a full run
```

The pipeline tests cover every cleaning rule and rejection reason, `MERGE` (updates, inserts, out-of-date rows, a rerun after a crash), the star schema on hand-checked data, each data check catching a deliberately broken table, and the real commands run end to end.

---

## Folder map

```
backend/src/
  app.js, server.js        server wiring, login, health
  routes/                  auth, hr (campaigns, candidates, results), candidate, call
  services/                call flow, question plan, brain, scoring, ATS score,
                           Gnani speech, invites and email, campaign scheduler
  middleware/              sign-in checks, roles, rate limits, security headers
client/                    React + Vite web app (HR dashboard and candidate screens)
database/                  Supabase schema, migrations and Row Level Security
pipeline/
  ingest/                  Raw layer: load Excel/CSV into Parquet
  transform/               Cleaned and Analytics layers (SQL), reports, Delta helpers
  checks/                  data checks
  dags/                    Airflow pipeline
  generate/                synthetic recruiter files
  tools/                   Delta version history (time travel)
  tests/, tests_airflow/   pipeline and Airflow tests
tests/                     app tests
```

## Security and privacy

- **Keys:** stay on the server; never sent to the browser or committed (`.env` is ignored by Git).
- **Database:** Row Level Security, so each workspace sees only its own data and candidates only their own records.
- **Sign-up:** Google sign-in only, so bots can't create workspaces; each workspace has usage limits, and their total number is capped.
- **Recordings:** played through short-lived signed links.
- **Requests:** rate limits and security headers on every request.
- **Pipeline:** file size limits, safe Excel parsing, no SQL built from input, and hashed emails in analytics.
- **Checks:** the pipeline code is scanned with bandit, and its dependencies with pip-audit.

## Data rules

Use made-up candidates and resumes only. Record only your own voice, or that of a teammate who agrees. Every Gnani model used is named above.

## License

MIT. See [LICENSE](LICENSE).
