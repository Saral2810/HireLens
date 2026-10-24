# Gnani.ai — Voice Campaign Platform (starter framework)

This is the **"body"** of an AI voice-calling platform: it can store leads, group them into campaigns, call them one by one through a dialer that respects calling hours and do-not-call lists, receive the call results, score each lead and show everything on a dashboard.

The **"brain"** is not included. That means no voice provider, no AI model, no database and no keys. You plug in your own:

- **Your Supabase** (the database + logins)
- **Your Gnani voice agent** (fill in `backend/src/services/voiceProvider/gnaniProvider.js`)
- **Your LLM** for reading transcripts, if you want one (any OpenAI-compatible API)

Until you add them, the app runs in **offline mock mode**, with an in-memory database and pretend calls, so you can try everything right away.

---

## 1. Run it in 3 steps

```bash
cp .env.example .env        # 1. make your settings file
npm install && npm run build  # 2. install + build the web UI
npm start                   # 3. start → open http://localhost:3000
```

Log in (mock mode): **superadmin@local.dev** / **ChangeMe@123**. Change it with `MOCK_ADMIN_PASSWORD` in `.env`.

UI development with hot reload: run `npm run dev` and `npm run client:dev` in two terminals, then open http://localhost:5173.

Run the tests: `npm test`

## 2. Connect your own pieces

| What | Where | Notes |
|---|---|---|
| Database | `.env` → `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Run `database/setup.sql` once first. See `database/README.md` |
| Super admin | `.env` → `SUPER_ADMIN_EMAILS` | Comma-separated emails |
| Encryption key | `.env` → `CREDENTIAL_ENCRYPTION_KEY` | Exactly 32 characters. Command is in `.env.example` |
| Gnani voice agent | `.env` → `GNANI_*` + `gnaniProvider.js` | Replace the `TODO` URLs/fields with Gnani's real API |
| LLM (optional) | `.env` → `LLM_API_URL`, `LLM_API_KEY`, `LLM_MODEL` | Blank = built-in rule-based analyzer |
| Public URL | `.env` → `PUBLIC_APP_URL` | Gnani must be able to reach `PUBLIC_APP_URL/leads/webhook/gnani` |
| Redis (scheduler) | `.env` → `REDIS_URL` | `docker compose up redis` gives you one locally |

## 3. How a call flows

```
Leads (CSV / API) ─► Campaign ─► Call queue ─► Dispatcher ─► gnaniProvider.initSession()  ──► Gnani places the call
                                                                                                │
Dashboard ◄── Lead score ◄── LLM analysis ◄── handleCallOutcome() ◄── POST /leads/webhook/gnani ◄┘
```

## 4. The one file you must finish: `gnaniProvider.js`

Every part of the app only talks to these methods, so once they work, everything works with Gnani:

| Method | What it must do |
|---|---|
| `initSession(lead, context, webhookUrl)` | Start the call. Return `{ provider_session_id }` |
| `parseWebhook(req, rawBody)` | Turn Gnani's webhook into `{ session_id, event_type, payload }`. Return `null` if the signature is bad |
| `fetchArtifacts(callId)` | Get the transcript / recording / summary after the call |
| `getAgents()` | List your Gnani agents (shown on the Agents page) |
| `getAgentExpectedVariables()` | Which variables your agent prompt uses (e.g. `customer_name`) |

Search the file for `TODO`. Those are the exact spots to change. `mockProvider.js` is a working example.

## 5. Folder map

```
backend/src/
  app.js, server.js          server wiring + login
  middleware/auth.js         auth, roles, tenant isolation
  routes/                    leads, campaigns, agents, scheduler, tenants, integrations, public API (/api/v1)
  services/
    voiceProvider/           base.js (template) · index.js (switch) · gnaniProvider.js · mockProvider.js
    queueService.js          call outcome handling + retries
    campaignDialer.js        "dial all" for a campaign
    llmService.js            transcript analysis (LLM slot)
    scoringEngine.js         lead scoring
    webhookService.js        outgoing webhooks to your systems
  workers/dispatcher.js      Postgres-driven dialer loop
client/                      React dashboard (Vite)
database/                    setup.sql + schema + migrations
tests/                       unit + integration tests (run in mock mode)
```

## 6. Safety notes

- No keys live in the code. Everything comes from `.env`, which is git-ignored.
- "Mock" login tokens are **refused** once a real Supabase is connected, unless you set `ALLOW_MOCK_AUTH=true`. Don't do that in production.
- Respect India's TRAI calling window (09:00–21:00). It is enforced by default (`BYPASS_CALLING_HOURS=false`).

See `CLEANUP_REPORT.md` for exactly what was removed from the original project.
