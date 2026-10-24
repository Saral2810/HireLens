# Cleanup report: LEADX → Gnani.ai

This project started as a copy of LEADX_CORE. It was cleaned against the "LEADX → Gnani AI Cleanup Checklist" (Oct 18, 2026). What's left is only the reusable framework.

## 1. Secrets removed (checklist §1)
All hardcoded keys and their `||` fallbacks are gone. The code now reads **only** from `.env`.
- Supabase service-role key, project URL, publishable and secret keys (`config/db.js`, `middleware/auth.js`, scripts)
- Sarvam API key (`routes/campaigns.js`, `aws/ecs-task-definition.json`)
- Azure OpenAI key and endpoint (`test_azure.js` deleted; `llmService.js` fallback removed)
- Slack webhook URL (`slackService.js`)
- Two hardcoded encryption keys (`credentialCrypto.js`). It now requires `CREDENTIAL_ENCRYPTION_KEY`
- AWS account ID / ECR address (`buildspec.yml` deleted)

**Extra security holes found and closed (not in the checklist):**
- `/api/auth/login` accepted fixed passwords (`admin123`, `Admin@123`, `Password@123`, `leadx`, `superadmin`) for any super-admin email, even with a real database. Removed. Real mode now uses Supabase Auth only.
- `Authorization: Bearer superadmin` / `Bearer mock-…` gave full super-admin access in production. Mock tokens now work only in offline mode or tests (or if `ALLOW_MOCK_AUTH=true`).
- Hardcoded Predixion user UUIDs and the `superadmin@leadx.in` email were removed from auth, tenants and SQL RLS policies. RLS now uses the Supabase `is_super_admin` app-metadata flag.

> ⚠️ Deleting keys from this copy does **not** switch them off. The original keys still work until Predixion rotates them.

## 2. Voice providers (checklist §2)
- Deleted: Voiz (`config/voiz.js`, `voizProvider.js`, `voizMockServer.js`, `voizDispositionMapper.js`, `mock_server.js`), Sarvam (`sarvamProvider.js`), ElevenLabs (`elevenLabsProvider.js`)
- Deleted the provider-specific webhooks: `/leads/voiz-webhook`, `/leads/webhook/voiz|sarvam|elevenlabs`, `/webhooks/sarvam`
- Deleted the provider-specific endpoints: `/campaigns/voice-providers`, `/create-agent`, `/delete-agent/:id`, `/leads/telephony/agents`, `/leads/telephony/health`, `/leads/calls/test-outbound`, `/leads/calls/test-status/:id`, `/admin/voice-providers/test-outbound-call`
- Rewritten to work with any provider: `/campaigns/configured-providers`, `/campaigns/voice-agents`, `/admin/agents`, `/admin/agents/test-call`, `/api/v1/telephony/health`
- **Kept**: `voiceProvider/base.js` (template) and `voiceProvider/index.js` (switch, now a registry)
- **Added**: `gnaniProvider.js` (stub with TODOs), `mockProvider.js` (offline testing), and one generic webhook `POST /leads/webhook/:provider`
- DB column `voiz_session_id` was renamed to `provider_session_id`, and `sarvam_interaction_id` was dropped

## 3. Database (checklist §3)
- Dropped migrations: `seed_fibe_leads`, `add_parkplus_callback_tracking`, `sarvam_voice_provider_and_variable_mappings`, `add_sarvam_interaction_id`
- Deleted `/leads/fetch-supabase`, `/leads/fetch-gsheet` and `GET /api/env`
- RLS migration: removed the seed rows for the parkplus/fibe/akshar tenants and users
- Fixed 3 bugs that stopped a fresh setup: a wrong column in the `ldx_id` migration, a `-- DOWN` block that dropped `tenant_voice_providers` straight after creating it, and a missing comma
- New `database/setup.sql`: one file, tested on a fresh PostgreSQL 16

## 4. Other outside services (checklist §4)
- LLM: Azure/Groq/xAI code replaced by one generic `LLM_API_URL / LLM_API_KEY / LLM_MODEL` slot. The Fibe loan prompt was replaced by a neutral template
- Slack: kept as optional (only if `SLACK_WEBHOOK_URL` is set)
- CRMs: `crmService.js` (including the team phone numbers) and `routes/oauth.js` deleted. A no-op `crmService.js` hook remains. CRM endpoints and the LeadSquared webhook were removed
- ParkPlus: `parkPlusCallbackService.js`, `parkPlusLogger.js` and every callback trigger deleted
- Old hosted URLs (`leadx-core.onrender.com`, `leadx.int.preprod.predixion.ai`, the Voiz dispatch server) replaced by `PUBLIC_APP_URL`
- Deployment configs deleted: `aws/`, `buildspec.yml`, `render.yaml`, `apprunner.yaml`, `.github/workflows`, `scripts/deploy-aws.*`, `docker-compose.prod.yml`. `Dockerfile` and `docker-compose.yml` were rewritten generically

## 5. Client-specific code (checklist §5)
- Fibe/ParkPlus/Akshar/EKL/upGrad: services, seed tenants, scoring rules, the AgentX loan state machine, the `ekl-ingest` endpoint, every `tenant_id === 'fibe'` branch, and ~60 one-off scripts deleted
- Docs (`docs/`, `MASTER_DOCUMENTATION.md`), `ui_assets/` design system, Predixion logos, `scratch/`, `inject.cjs`, `append.cjs`, `diff.txt`, `mcp-server/` deleted
- Company process files (CODEOWNERS, SECURITY, CONTRIBUTING, Code of Conduct, PR template) deleted
- Frontend: the old 15k-line legacy UI (`frontend/`, `client/src/app.js`, old `client/index.html`) and `client/dist` deleted. The React app in `client/src` is now the UI. All fake demo data (sample leads, campaigns, agents, "1,039 leads", Fibe transcripts) was removed

## 6. Kept (the body, checklist §6)
Express wiring, auth + roles + tenant isolation, tenants, campaigns, leads, call queue, Postgres dispatcher, retries, calling-hours enforcement (TRAI 09:00–21:00), DNC, scheduler (BullMQ), notes, analytics/dashboard, outgoing webhooks + API keys, variable mapping, scoring engine and the React dashboard.

## Verification
- Secret scan over every file (UTF-8 and UTF-16): no keys, project IDs, client names or old URLs remain
- `npm test`: all unit + integration tests pass (tests for deleted features were removed; the login tests were rewritten to prove the old backdoor passwords are rejected)
- The server boots in mock mode, login works and the React UI builds and loads
- `database/setup.sql` runs cleanly on an empty PostgreSQL 16 database
