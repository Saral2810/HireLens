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

function requireClient() {
  if (!supabase) {
    const err = new Error('Database not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.');
    err.status = 503;
    throw err;
  }
  return supabase;
}

function unwrap({ data, error }) {
  if (error) throw error;
  return data;
}

// Data functions for the HR screening tables, added phase by phase (see the v3 roadmap).
const db = {
  supabase,
  isConfigured: !!supabase,

  /** @returns {Promise<{id, name, email, role}|null>} */
  async getProfile(userId) {
    return unwrap(await requireClient().from('profiles').select('id, name, email, role').eq('id', userId).maybeSingle());
  },

  // Supabase Auth stores emails in lower case.
  async getProfileByEmail(email) {
    return unwrap(await requireClient().from('profiles').select('id, name, email, role').eq('email', String(email).trim().toLowerCase()).maybeSingle());
  },

  /** Candidate row with its batch, or null. */
  async getCandidate(candidateId) {
    return unwrap(await requireClient()
      .from('candidates')
      .select('id, batch_id, user_id, name, email, status, resume_path, batch:batches(id, name, batch_date, job_role, company_name)')
      .eq('id', candidateId)
      .maybeSingle());
  },

  /** The signed-in candidate's most recent candidate row (with batch), or null. */
  async getCandidateForUser(userId) {
    const rows = unwrap(await requireClient()
      .from('candidates')
      .select('id, batch_id, name, email, status, failure_reason, consent_at, resume_path, resume_questions, batch:batches(id, name, batch_date, job_role, company_name, job_description)')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1));
    return rows?.[0] || null;
  },

  async linkCandidateUser(candidateId, userId) {
    unwrap(await requireClient().from('candidates').update({ user_id: userId }).eq('id', candidateId));
  },

  // ── Batches (Phase E) ──

  /** All batches, newest first, with candidate counts per status. */
  async listBatches() {
    const client = requireClient();
    const batches = unwrap(await client.from('batches').select('*').order('batch_date', { ascending: false }).order('created_at', { ascending: false }));
    const rows = unwrap(await client.from('candidates').select('batch_id, status'));
    const counts = {};
    for (const r of rows || []) {
      counts[r.batch_id] ??= { total: 0, invited: 0, resume_uploaded: 0, in_call: 0, completed: 0, failed: 0 };
      counts[r.batch_id].total += 1;
      counts[r.batch_id][r.status] += 1;
    }
    return (batches || []).map(b => ({ ...b, counts: counts[b.id] || { total: 0, invited: 0, resume_uploaded: 0, in_call: 0, completed: 0, failed: 0 } }));
  },

  async getBatch(batchId) {
    return unwrap(await requireClient().from('batches').select('*').eq('id', batchId).maybeSingle());
  },

  async createBatch(fields) {
    return unwrap(await requireClient().from('batches').insert(fields).select('*').single());
  },

  async updateBatch(batchId, fields) {
    return unwrap(await requireClient().from('batches').update(fields).eq('id', batchId).select('*').maybeSingle());
  },

  async deleteBatch(batchId) {
    unwrap(await requireClient().from('batches').delete().eq('id', batchId));
  },

  // ── HR questions (Phase E) ──

  async listQuestions(batchId) {
    return unwrap(await requireClient().from('hr_questions').select('*').eq('batch_id', batchId).order('position'));
  },

  async getQuestion(questionId) {
    return unwrap(await requireClient().from('hr_questions').select('*').eq('id', questionId).maybeSingle());
  },

  /** Appends questions after the batch's last one. */
  async addQuestions(batchId, questions) {
    const client = requireClient();
    const last = unwrap(await client.from('hr_questions').select('position').eq('batch_id', batchId).order('position', { ascending: false }).limit(1));
    const start = last?.length ? last[0].position + 1 : 0;
    const rows = questions.map((q, i) => ({ batch_id: batchId, question_text: q.question_text, answer_type: q.answer_type, position: start + i }));
    return unwrap(await client.from('hr_questions').insert(rows).select('*'));
  },

  async updateQuestion(questionId, fields) {
    return unwrap(await requireClient().from('hr_questions').update(fields).eq('id', questionId).select('*').maybeSingle());
  },

  async deleteQuestion(questionId) {
    unwrap(await requireClient().from('hr_questions').delete().eq('id', questionId));
  },

  /**
   * Sets the order of a batch's questions. Each update is its own request, so positions first move
   * to a free range (10000+) and then to 0..n-1, which never collides with the unique (batch, position).
   */
  async reorderQuestions(batchId, orderedIds) {
    const client = requireClient();
    for (const [i, id] of orderedIds.entries()) {
      unwrap(await client.from('hr_questions').update({ position: 10000 + i }).eq('id', id).eq('batch_id', batchId));
    }
    for (const [i, id] of orderedIds.entries()) {
      unwrap(await client.from('hr_questions').update({ position: i }).eq('id', id).eq('batch_id', batchId));
    }
    return this.listQuestions(batchId);
  },

  // ── Candidates (Phase E) ──

  async listCandidates(batchId) {
    return unwrap(await requireClient()
      .from('candidates')
      .select('id, batch_id, user_id, name, email, status, failure_reason, resume_path, created_at, updated_at')
      .eq('batch_id', batchId)
      .order('created_at'));
  },

  async countCandidates(batchId) {
    const { count, error } = await requireClient().from('candidates').select('id', { count: 'exact', head: true }).eq('batch_id', batchId);
    if (error) throw error;
    return count || 0;
  },

  /** Adds candidates; emails already in the batch are skipped. @returns inserted rows */
  async addCandidates(batchId, candidates) {
    const rows = candidates.map(c => ({ batch_id: batchId, name: c.name, email: c.email }));
    return unwrap(await requireClient()
      .from('candidates')
      .upsert(rows, { onConflict: 'batch_id,email', ignoreDuplicates: true })
      .select('id, batch_id, user_id, name, email, status, created_at'));
  },

  async updateCandidate(candidateId, fields) {
    return unwrap(await requireClient().from('candidates').update(fields).eq('id', candidateId).select('id, status, consent_at, resume_path').single());
  },

  /** Saves a file to private storage (replacing any earlier version at the same path). */
  async uploadFile(bucket, path, buffer, contentType) {
    const { error } = await requireClient().storage.from(bucket).upload(path, buffer, { contentType, upsert: true });
    if (error) throw error;
    return path;
  },

  async deleteCandidate(candidateId) {
    unwrap(await requireClient().from('candidates').delete().eq('id', candidateId));
  },

  /** Updates the candidate only while it still has `fromStatus` (guards against two tabs racing). @returns row or null */
  async updateCandidateIfStatus(candidateId, fromStatus, fields) {
    const rows = unwrap(await requireClient().from('candidates').update(fields).eq('id', candidateId).eq('status', fromStatus).select('id, status'));
    return rows?.[0] || null;
  },

  // ── Calls and answers (Phase G) ──

  async createCall({ candidateId, questionPlan }) {
    return unwrap(await requireClient()
      .from('calls')
      .insert({ candidate_id: candidateId, status: 'in_progress', question_plan: questionPlan, transcript: [] })
      .select('*')
      .single());
  },

  async getCall(callId) {
    return unwrap(await requireClient().from('calls').select('*').eq('id', callId).maybeSingle());
  },

  /** The candidate's newest call, or null. */
  async getLatestCallForCandidate(candidateId) {
    const rows = unwrap(await requireClient()
      .from('calls')
      .select('*')
      .eq('candidate_id', candidateId)
      .order('started_at', { ascending: false })
      .limit(1));
    return rows?.[0] || null;
  },

  async getActiveCallForCandidate(candidateId) {
    const rows = unwrap(await requireClient()
      .from('calls')
      .select('*')
      .eq('candidate_id', candidateId)
      .eq('status', 'in_progress')
      .order('started_at', { ascending: false })
      .limit(1));
    return rows?.[0] || null;
  },

  async updateCall(callId, fields) {
    return unwrap(await requireClient().from('calls').update(fields).eq('id', callId).select('*').single());
  },

  /** Saves the answer for one plan position (a later save for the same position replaces it). */
  async upsertAnswer(callId, answer) {
    return unwrap(await requireClient()
      .from('answers')
      .upsert({ call_id: callId, ...answer }, { onConflict: 'call_id,position' })
      .select('*')
      .single());
  },

  async listAnswers(callId) {
    return unwrap(await requireClient().from('answers').select('*').eq('call_id', callId).order('position'));
  },

  // ── Results (Phase H) ──

  /** Every call of these candidates (without the transcript, which can be long). */
  async listCallsForCandidates(candidateIds) {
    if (!candidateIds.length) return [];
    return unwrap(await requireClient()
      .from('calls')
      .select('id, candidate_id, status, recording_path, summary, fit_score, failure_reason, started_at, ended_at')
      .in('candidate_id', candidateIds));
  },

  async listAnswersForCalls(callIds) {
    if (!callIds.length) return [];
    return unwrap(await requireClient().from('answers').select('*').in('call_id', callIds).order('position'));
  },

  /** Time-limited link to a private file. */
  async signedUrl(bucket, path, seconds) {
    const { data, error } = await requireClient().storage.from(bucket).createSignedUrl(path, seconds);
    if (error) throw error;
    return data.signedUrl;
  }
};

export default db;
