# Test cases: call improvements (1 Nov 2026)

Automated coverage: `npm test` (unit) and `npm run test:qa` (unit + integration, offline, no credits).
The manual cases below need a browser, a microphone and real Gnani/LLM keys (they use credits).
Use made-up candidates and your own voice only.

## A. Automated (what each suite checks)

| Area | Unit (`tests/unit`) | Integration (`tests/qa/integration`) |
|---|---|---|
| Company briefing | written by the model in the call language, cached, fallback to HR text, banned topics refused, long intro shortened | spoken once after "ready", before question 1; fallback; none without an intro; 1500-char limit; PATCH clears |
| Wizard / campaign fields | `validateBatchInput` company intro + languages | create/patch with `company_intro`, `call_languages` |
| Campaign languages | `allowedLanguages`, `pickLanguage` | candidate sees only allowed ones; a disallowed choice falls back; bad lists refused |
| Call language | plan lines per language, translation cache and fallback, STT/TTS codes | English start; unknown code → English + Hindi; Hindi call sends `hi-IN,en-IN` |
| Fresher (said in call) | detection, denial ("not a fresher"), next-question skip, "Not asked (fresher)" | full call skips notice + current CTC; "not a fresher" keeps them |
| Fresher (from resume) | `writeResumeQuestions.isFresher`, plan without those questions | `is_fresher` saved; plan has 7 questions instead of 10 |
| Follow-up questions | only when allowed, safe text, joined answer row | one follow-up → joined answer; max two per call; never on HR questions; banned follow-up not spoken |
| Output checks (BUG-16) | banned topics, yes/no type check, fit-score ceiling, steering answers | (QA unit) generated banned questions dropped; injected "fit_score 100" capped |
| CTC labels (BUG-44) | expected vs current wording incl. Hinglish | — |
| Prisma v3.0 | model field, language hints, keyterms/topic/previous_text, 60 s split into 3 parts, v2.5 fallback, v3 error shape | every answer sent with `prisma-v3.0` and call context; v2.5 via env |
| Pre-voicing | lines per allowed language, keeps going on failure | run campaign → shared lines voiced in the background; first call only voices the greeting |
| Results screen | — | custom HR question answers in results rows |

## B. Manual test cases

| # | Steps | Expected |
|---|---|---|
| M1 | HR → New campaign. Step 1: company name, job role, "About the company", languages. Click Continue. | Company name and role are required. Campaign name fills itself as "Role – Company". Step 2 is the questions. |
| M2 | In step 2, type a custom question but do not press Add; click Continue. | The question is in the list (and on the Review step). |
| M3 | Run the campaign; open the candidate link; upload a resume; consent. | Language buttons show only the languages ticked in M1. |
| M4 | Start the call in English + Hindi; say "haan". | Agent speaks a short briefing about the company, then the first resume question. |
| M5 | Answer a resume question vaguely ("bas ek project kiya tha"). | Agent asks one short follow-up about it; the next answer moves on. At most two follow-ups per call. |
| M6 | While the agent is asking a question, start talking. | Agent stops at once and listens; your first words are in the transcript. "Heard you say" shows your words after each answer. |
| M7 | Say "main fresher hoon" in any answer. | Notice period and current CTC are not asked; Results show "Not asked (fresher)" for them. |
| M8 | Upload a resume with only college projects and internships (made-up). | The call has no notice period / current CTC questions at all. |
| M9 | Take a call in English, then (after Retake) one in Hindi. | Agent lines and questions are in the chosen language; answers in Hindi are understood (Prisma v3.0). |
| M10 | Answer one question for about 40 seconds. | The whole answer is transcribed (sent to Prisma in two parts). |
| M11 | HR → Results. | One column per custom HR question; CTC columns correct; fit score lower when answers were skipped. |
| M12 | Edit campaign → change "About the company" and languages; start a new call. | The new briefing and language list are used. |

Live speech check (a few credits): `node backend/scripts/speechSmokeTest.js "Mera notice period do mahine ka hai" mixed`, then with `hi` and a Hindi sentence.


# Test cases: 2 Nov 2026 changes

Automated: `tests/unit/release_2nov.test.js` (unit) and `tests/qa/integration/release_2nov.int.test.js` (integration + security).

## A. Automated coverage

| Area | What is checked |
|---|---|
| Sign-in without the Supabase address | Google ID-token sign-in links the candidate; wrong nonce (replay), wrong audience, forged signature → 401; HR emails, strangers and draft campaigns get the same 401 as a made-up token (no email probing), and no account is made; bad input → 400; not configured → 503; rate limit → 429; responses are `no-store`. HR "copy link" is a `/join` link on the app address; `/join` signs in on the server and returns no Supabase URL; one-time links are used up server-side; tampered tokens and HR emails get no session. CSP allows only Google's sign-in script and frame; referrer is origin-only. |
| Earlier screenings hidden | `/api/candidate/screenings` is gone (404); the candidate page no longer lists other campaigns. |
| Scheduling | draft start + close times; past / >180 days / garbage / object / close-before-start / no candidates / closed campaign → 400; live campaigns take only a close time; owner-only (other recruiter 404, candidate 403); PATCH cannot set `scheduled_at`, `closes_at` or `status`; the scheduler starts a due campaign once even when two checks race, emails every candidate a `/join` link, then closes it at the close time; no candidates → schedule dropped; no PUBLIC_APP_URL → starts without emails; Run now / Close / DELETE clear the schedule. |
| Call order | ready → company briefing + "project you are most proud of" → "biggest problem and how you solved it" (both cross-questioned: `probe`) → up to 3 resume questions → "full-time job before, or fresher?" → HR questions. Follow-ups: max 3 per call, project questions first, never on the experience check or HR questions. |
| Fresher rule | "nahi, fresher hoon" / plain "no" (also with the LLM down) to the experience check skips notice period and current CTC; saying it at the notice question moves on without a repeat and skips current CTC; "I am a student", "no work experience" count, "not a fresher" does not; a free-text "current salary" question is skipped; resume-detected freshers get no experience check. |

## B. Manual test cases

| # | Steps | Expected |
|---|---|---|
| N1 | Set `GOOGLE_CLIENT_ID` (see .env.example), open the candidate sign-in. | Google's own button; the popup says "to continue to" your app address, never `…supabase.co`. |
| N2 | Open an invite email link. | The address bar shows only your app (`/join` then `/candidate`); no Supabase page. |
| N3 | Finish a call, reload the candidate page. | No "Your other screenings" list. |
| N4 | New campaign → Review → "Schedule for a later day", pick a time a few minutes ahead → Schedule. | Campaign shows "Scheduled"; candidates cannot sign in yet; at the time it goes live and invite emails arrive. |
| N5 | Campaign page → Close time → set; wait. | It closes by itself; Results stay. |
| N6 | Take a call. | Briefing → most-proud project → a cross-question → biggest problem → a cross-question → resume questions → "full-time job before, or fresher?" → HR questions. No "Heard you say" line. |
| N7 | Answer "Nahi, main fresher hoon" to the experience question. | Next question is expected CTC; Results show notice period and current CTC as "Not asked (fresher)". |

# Test cases: 3 Nov 2026 (HireLens branding, fit rubric, ATS, summary of call, live demo)

Automated: `tests/unit/hirelens_features.test.js` (unit), `tests/qa/integration/hirelens_features.int.test.js` (integration + penetration). UAT: `tests/qa/uat/server.js` (seeded local app, checked in a browser).

## A. Automated

| Area | Checks |
|---|---|
| Branding | No Gnani, Prisma, Timbre, Poorvi, "HR Screening" or "AI screening" in any client source file or in the built site; header and page title say HireLens. |
| Fit score rubric | Weights add to 100; 10s → 100, 0s → 0; weighted points and reasons in the breakdown; out-of-range or text ratings dropped, missing parts scaled, fewer than 3 rated → no score; opening and fresher-skipped questions not counted; steering answers cap at 40 (also with an obedient model, end to end). |
| ATS score | Good resume scores high with 5 explained checks totalling 100; weak resume scores low with tips; unreadable → 0 with a tip; job keywords skip filler and match plurals / node.js / short skills; same input, same score; stored on upload; old resumes scored on first results load; ATS column in CSV/Excel. |
| Summary of call | `GET /api/hr/calls/:id` returns scores, both breakdowns, answers, transcript and campaign. |
| Penetration | Summary endpoint: other recruiter 404 (IDOR), candidate 403, no token 401, malformed / traversal / SQL-ish ids 404; script in an answer returned as JSON text with nosniff; no `dangerouslySetInnerHTML` in the UI; candidates never receive ATS, fit, fresher flag or resume questions; PATCH cannot write scores; `/live` cannot be framed unless allowlisted, and then only by exact https origins (wildcards, paths, injected CSP, http, `*` rejected); every other page stays `frame-ancestors 'none'`; the demo has no network code. |
| Live demo engine | Script in time order, made-up people only; state at start / middle / end; dropped call and retry; fresher; newest-first feed capped at 40. |

## B. UAT (run 3 Nov in a browser against the seeded local app)

| # | Step | Result |
|---|---|---|
| U1 | Landing page | Pass: HireLens · Indian voice agents; "See it live" and "Live demo" links; no model names. |
| U2 | /live at 4× | Pass: counters, pipeline, dropped-call retry, Hindi call word for word, activity feed, shortlist. Found and fixed: new chat lines scrolled the whole page. |
| U3 | /live?embed=1 on a phone (375 px) | Pass: no header, no sideways scroll. |
| U4 | HR campaigns tabs | Pass: All / Live / Draft / Completed; the Completed filter shows only the ended campaign; badge reads Completed. |
| U5 | Results table | Pass: Fit and ATS columns. Found and fixed: "Summary of call" sat off-screen at the right of wide tables; it is now under each name. |
| U6 | Summary of call | Pass: both scores, both breakdowns with reasons and tips, key facts, answers in 4 groups, transcript (27 lines), section links, score explainer, print button. |
| U7 | Console | Pass: no errors. |

## C. Manual checks still to do on the deployed site

| # | Step | Expected |
|---|---|---|
| H1 | Upload a real resume, finish a real call | ATS score on upload; fit score with four reasons once the summary is written (live LLM). |
| H2 | Print the Summary of call | Header and navigation hidden; scores, answers and transcript on paper / PDF. |
| H3 | Set `LIVE_DEMO_EMBED_ORIGINS` to your website and embed `/live?embed=1` in an iframe | Shows on your site; the same URL in an iframe on any other site is refused by the browser. |
