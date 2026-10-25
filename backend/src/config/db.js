import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// All credentials come ONLY from your .env file. No hardcoded fallbacks.
const supabaseUrl = process.env.SUPABASE_URL || '';
let rawServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || '';
// Safeguard: the backend needs a service-role / secret key, not a publishable/anon key
if (rawServiceKey && (rawServiceKey.startsWith('sb_publishable_') || rawServiceKey.includes('"role":"anon"'))) {
  console.warn('[DB Config] WARNING: SUPABASE_SERVICE_ROLE_KEY looks like a publishable/anon key. Use the service-role (secret) key for the backend.');
  rawServiceKey = '';
}
const supabaseKey = rawServiceKey;

const isTestRunnerActive = process.env.NODE_ENV === 'test';
const isSupabaseConfigured = !!supabaseUrl && !!supabaseKey;

// The shared client must keep using the service-role key. supabase-js sends a stored session's
// token instead of the key, so it must never hold a session (see createAuthClient below).
const SERVER_AUTH_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

/**
 * Throwaway client for user sign-in. Signing in on the shared client would switch every later
 * query to that user's token (and RLS).
 * @returns {import('@supabase/supabase-js').SupabaseClient|null}
 */
export function createAuthClient() {
  if (!isSupabaseConfigured) return null;
  return createClient(supabaseUrl, supabaseKey, SERVER_AUTH_OPTIONS);
}

let supabase = null;
if (isSupabaseConfigured && !isTestRunnerActive) {
  try {
    supabase = createClient(supabaseUrl, supabaseKey, SERVER_AUTH_OPTIONS);
    console.log('Successfully initialized Supabase client.');
  } catch (error) {
    console.error('Failed to initialize Supabase client:', error);
  }
} else if (!isTestRunnerActive) {
  console.warn('[DB Config] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set. Logins and data will not work until they are.');
}

// Data functions for the HR screening tables are added here phase by phase (see the v3 roadmap).
const db = {
  supabase,
  isConfigured: !!supabase
};

export default db;
