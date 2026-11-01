// QA harness setup. Loaded with `node --import ./tests/qa/setup.js` before every QA test and the load simulation.
//
// Goal: nothing in the QA suite can spend Gnani or LLM credits or touch the real Supabase project.
//  1. Real credentials are blanked BEFORE any app module runs dotenv (dotenv never overrides a variable
//     that is already set, even to an empty string), so the app cannot build a real Supabase client.
//  2. Gnani and the LLM get obviously fake keys and a fake LLM host (.invalid never resolves in DNS).
//  3. Mail settings are blanked too; the mailer refuses real SMTP under NODE_ENV=test, and tests
//     capture invite emails with an in-memory transport (helpers/mail.js).
//  4. globalThis.fetch is replaced by a guard: Gnani (api.vachana.ai) and the fake LLM host are answered
//     by in-process fakes, localhost passes through, and every other host is refused with an error.
import { installNetworkGuard } from './helpers/network.js';

process.env.NODE_ENV = 'test';

for (const key of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM', 'MAIL_REPLY_TO', 'MAIL_PROVIDER', 'BREVO_API_KEY', 'RESEND_API_KEY']) {
  process.env[key] = '';
}

Object.assign(process.env, {
  GNANI_SPEECH_API_KEY: 'qa-fake-gnani-key',
  GNANI_TTS_VOICE: 'QA-Voice',
  GNANI_TTS_MODEL: 'timbre-v2.5',
  GNANI_TTS_LANGUAGE: 'hi-en',
  GNANI_STT_LANGUAGE: 'en-IN',
  LLM_API_URL: 'http://fake-llm.qa.invalid/v1/chat/completions',
  LLM_API_KEY: 'qa-fake-llm-key',
  LLM_MODEL: 'qa-fake-model',
  LLM_AUTH_HEADER: 'bearer',
  LLM_REASONING_EFFORT: '',
  PUBLIC_APP_URL: 'http://qa.localhost',
  // Signs the /join links in invite emails (tests send email only to an in-memory fake, see helpers/mail.js).
  INVITE_SECRET: 'qa-invite-secret-0123456789abcdef0123456789',
  INVITE_LINK_DAYS: '30',
  // Background voicing on "Run campaign" would add Timbre requests to every test; it has its own tests.
  PREVOICE_ON_RUN: '0'
});

installNetworkGuard();
