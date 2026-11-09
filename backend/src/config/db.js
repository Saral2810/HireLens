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

  /** @returns {Promise<{id, name, email, role, workspace_id}|null>} */
  async getProfile(userId) {
    return unwrap(await requireClient().from('profiles').select('id, name, email, role, workspace_id').eq('id', userId).maybeSingle());
  },

  // Supabase Auth stores emails in lower case.
  async getProfileByEmail(email) {
    return unwrap(await requireClient().from('profiles').select('id, name, email, role, workspace_id').eq('email', String(email).trim().toLowerCase()).maybeSingle());
  },

  /** Candidate row with its batch, or null. */
  async getCandidate(candidateId) {
    return unwrap(await requireClient()
      .from('candidates')
      .select('id, batch_id, user_id, name, email, status, resume_path, ats_score, ats_breakdown, batch:batches(id, name, batch_date, job_role, company_name, created_by, status, workspace_id)')
      .eq('id', candidateId)
      .maybeSingle());
  },

  /**
   * The signed-in candidate's most recent screening in a live or closed campaign (draft campaigns
   * are not visible to candidates yet), or null.
   */
  async getCandidateForUser(userId) {
    const rows = unwrap(await requireClient()
      .from('candidates')
      .select('id, batch_id, name, email, status, failure_reason, consent_at, resume_path, resume_questions, is_fresher, batch:batches!inner(id, name, batch_date, job_role, company_name, company_intro, call_languages, job_description, status, workspace_id)')
      .eq('user_id', userId)
      .neq('batch.status', 'draft')
      .order('created_at', { ascending: false })
      .limit(1));
    return rows?.[0] || null;
  },

  /**
   * Links candidate rows added by HR (matched by email) to the account that just proved it owns
   * that email (Google or email code). Only rows not yet linked to anyone are claimed.
   * @returns {Promise<number>} rows linked
   */
  async claimCandidatesByEmail(userId, email) {
    if (!email) return 0;
    const rows = unwrap(await requireClient()
      .from('candidates')
      .update({ user_id: userId })
      .eq('email', String(email).trim().toLowerCase())
      .is('user_id', null)
      .select('id'));
    return rows?.length || 0;
  },

  /** True if this email has a screening in a live campaign (used before sending a sign-in code). */
  async hasLiveScreening(email) {
    const rows = unwrap(await requireClient()
      .from('candidates')
      .select('id, batch:batches!inner(status)')
      .eq('email', String(email).trim().toLowerCase())
      .eq('batch.status', 'live')
      .limit(1));
    return (rows?.length || 0) > 0;
  },

  /** Every screening for this email, in any campaign, with the campaign's owner. */
  async listCandidatesByEmail(email) {
    return unwrap(await requireClient()
      .from('candidates')
      .select('id, batch_id, user_id, batch:batches(id, created_by, workspace_id)')
      .eq('email', String(email).trim().toLowerCase()));
  },

  async linkCandidateUser(candidateId, userId) {
    unwrap(await requireClient().from('candidates').update({ user_id: userId }).eq('id', candidateId));
  },

  // ── Server-side sign-in: the browser never visits the Supabase address ──

  /**
   * Turns a magic link (made with auth.admin.generateLink) into a session right here, using its
   * token hash, instead of sending the candidate's browser to <project>.supabase.co to open it.
   * @returns {Promise<{ accessToken: string, user: { id: string, email: string } }>}
   */
  async exchangeLinkToken(tokenHash) {
    const client = createAuthClient();
    if (!client) throw Object.assign(new Error('Database not configured.'), { status: 503 });
    const { data, error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: 'magiclink' });
    if (error || !data?.session) throw Object.assign(new Error('The sign-in link could not be used.'), { status: 502 });
    return { accessToken: data.session.access_token, user: { id: data.user.id, email: data.user.email } };
  },

  /**
   * Signs in with a Google ID token from Google's own sign-in button (Google checks the account;
   * Supabase checks the token's signature, audience and nonce).
   * @returns {Promise<{ accessToken: string, user: { id: string, email: string } }|null>} null = token refused
   */
  async signInWithGoogleIdToken(idToken, nonce) {
    const client = createAuthClient();
    if (!client) throw Object.assign(new Error('Database not configured.'), { status: 503 });
    const { data, error } = await client.auth.signInWithIdToken({ provider: 'google', token: idToken, nonce });
    if (error || !data?.session) return null;
    return { accessToken: data.session.access_token, user: { id: data.user.id, email: data.user.email } };
  },

  // ── Batches (Phase E) ──

  /**
   * Batches (campaigns) of one workspace, newest first, with candidate counts per status.
   * @param {{ workspaceId: string, ownerId?: string }} scope ownerId = only batches this user created (recruiters)
   */
  async listBatches({ workspaceId, ownerId } = {}) {
    if (!workspaceId) throw new Error('listBatches needs a workspaceId.');
    const client = requireClient();
    let query = client.from('batches').select('*').eq('workspace_id', workspaceId)
      .order('batch_date', { ascending: false }).order('created_at', { ascending: false });
    if (ownerId) query = query.eq('created_by', ownerId);
    const batches = unwrap(await query);
    if (!batches?.length) return [];
    const rows = unwrap(await client.from('candidates').select('batch_id, status').in('batch_id', batches.map(b => b.id)));
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

  /**
   * Updates a batch only while it still has `status`, so two servers (or a click and the scheduler)
   * cannot both start or close it. @returns the updated batch, or null if the status had changed.
   */
  async updateBatchIfStatus(batchId, status, fields) {
    return unwrap(await requireClient().from('batches').update(fields).eq('id', batchId).eq('status', status).select('*').maybeSingle());
  },

  /** Campaigns the scheduler must act on: drafts whose start time has come, live ones whose close time has. */
  async listDueSchedules(nowIso) {
    const client = requireClient();
    const [starting, closing] = await Promise.all([
      client.from('batches').select('*').eq('status', 'draft').not('scheduled_at', 'is', null).lte('scheduled_at', nowIso),
      client.from('batches').select('*').eq('status', 'live').not('closes_at', 'is', null).lte('closes_at', nowIso)
    ]);
    return { starting: unwrap(starting) || [], closing: unwrap(closing) || [] };
  },

  async deleteBatch(batchId) {
    unwrap(await requireClient().from('batches').delete().eq('id', batchId));
  },

  /**
   * Removes a batch's resumes and recordings (resumes/<batch>/…, recordings/<batch>/…).
   * Database cascades do not reach storage. @returns {Promise<number>} files removed
   */
  async removeBatchFiles(batchId) {
    const storage = requireClient().storage;
    let removed = 0;
    for (const bucket of ['resumes', 'recordings']) {
      // Listing pages hold at most 1000 names; removing them shrinks the folder, so list again from the start.
      for (;;) {
        const { data, error } = await storage.from(bucket).list(batchId, { limit: 1000 });
        if (error) throw error;
        const paths = (data || []).filter(f => f.name).map(f => `${batchId}/${f.name}`);
        if (!paths.length) break;
        const { error: removeError } = await storage.from(bucket).remove(paths);
        if (removeError) throw removeError;
        removed += paths.length;
        if (paths.length < 1000) break;
      }
    }
    return removed;
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

  /** Resume text of this batch's candidates who have a resume but no ATS score yet (resumes uploaded before ATS scoring). */
  async listResumesWithoutAts(batchId) {
    return unwrap(await requireClient()
      .from('candidates')
      .select('id, resume_text')
      .eq('batch_id', batchId)
      .not('resume_path', 'is', null)
      .is('ats_score', null));
  },

  async listCandidates(batchId) {
    return unwrap(await requireClient()
      .from('candidates')
      .select('id, batch_id, user_id, name, email, status, failure_reason, resume_path, ats_score, ats_breakdown, invite_email_sent_at, invite_email_error, created_at, updated_at')
      .eq('batch_id', batchId)
      .order('created_at'));
  },

  /** HR corrects a candidate's name or email (see PATCH /api/hr/candidates/:id). */
  async updateCandidateDetails(candidateId, fields) {
    unwrap(await requireClient().from('candidates').update(fields).eq('id', candidateId));
  },

  /** Records the outcome of an invite email ({ invite_email_sent_at?, invite_email_error }). */
  async markInviteEmail(candidateId, fields) {
    unwrap(await requireClient().from('candidates').update(fields).eq('id', candidateId));
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
      .select('id, candidate_id, status, recording_path, summary, fit_score, fit_breakdown, failure_reason, started_at, ended_at')
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
  },

  // ── Dashboard and team (UI rebuild) ──

  /** Candidates of these batches, light columns only (for analytics). */
  async listCandidatesForBatches(batchIds) {
    if (!batchIds.length) return [];
    return unwrap(await requireClient()
      .from('candidates')
      .select('id, batch_id, name, email, status, created_at')
      .in('batch_id', batchIds));
  },

  /** HR accounts (Admin, HR lead, Recruiter) of one workspace, for the Team page. */
  async listStaff({ workspaceId } = {}) {
    if (!workspaceId) throw new Error('listStaff needs a workspaceId.');
    return unwrap(await requireClient()
      .from('profiles')
      .select('id, name, email, role, created_at')
      .eq('workspace_id', workspaceId)
      .in('role', ['superadmin', 'hr_lead', 'recruiter'])
      .order('created_at'));
  },

  async updateProfile(userId, fields) {
    return unwrap(await requireClient().from('profiles').update(fields).eq('id', userId).select('id, name, email, role, workspace_id').maybeSingle());
  },

  /** Moves every campaign of one HR account to another (before removing an account). */
  async reassignBatches(fromUserId, toUserId) {
    unwrap(await requireClient().from('batches').update({ created_by: toUserId }).eq('created_by', fromUserId));
  },

  // ── Workspaces ──

  async getWorkspace(workspaceId) {
    return unwrap(await requireClient().from('workspaces').select('*').eq('id', workspaceId).maybeSingle());
  },

  async createWorkspace(fields) {
    return unwrap(await requireClient().from('workspaces').insert(fields).select('*').single());
  },

  async countWorkspaces({ kind }) {
    const { count, error } = await requireClient().from('workspaces').select('id', { count: 'exact', head: true }).eq('kind', kind);
    if (error) throw error;
    return count || 0;
  },

  async countBatchesInWorkspace(workspaceId) {
    const { count, error } = await requireClient().from('batches').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId);
    if (error) throw error;
    return count || 0;
  },

  async countMembers(workspaceId) {
    const { count, error } = await requireClient().from('profiles').select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).in('role', ['superadmin', 'hr_lead', 'recruiter']);
    if (error) throw error;
    return count || 0;
  },

  /** Candidate ids in a workspace's campaigns (a demo workspace holds a few dozen at most). */
  async candidateIdsInWorkspace(workspaceId) {
    const client = requireClient();
    const batches = unwrap(await client.from('batches').select('id').eq('workspace_id', workspaceId)) || [];
    if (!batches.length) return [];
    const rows = unwrap(await client.from('candidates').select('id').in('batch_id', batches.map(b => b.id))) || [];
    return rows.map(r => r.id);
  },

  async countCompletedCallsInWorkspace(workspaceId) {
    const ids = await this.candidateIdsInWorkspace(workspaceId);
    if (!ids.length) return 0;
    const { count, error } = await requireClient().from('calls').select('id', { count: 'exact', head: true })
      .eq('status', 'completed').in('candidate_id', ids);
    if (error) throw error;
    return count || 0;
  },

  /** Invite emails sent from a workspace since `sinceIso` (from candidates.invite_email_sent_at). */
  async countInviteEmailsSince(workspaceId, sinceIso) {
    const ids = await this.candidateIdsInWorkspace(workspaceId);
    if (!ids.length) return 0;
    const { count, error } = await requireClient().from('candidates').select('id', { count: 'exact', head: true })
      .in('id', ids).gte('invite_email_sent_at', sinceIso);
    if (error) throw error;
    return count || 0;
  }
};

export default db;
