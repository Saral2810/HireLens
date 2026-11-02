// In-memory stand-in for backend/src/config/db.js, so routes run end to end without Supabase.
// It replaces the methods on the shared `db` object (routes call db.method at request time), keeps the
// same return shapes, and enforces the constraints the real schema has (unique keys, status values,
// text columns). Values go through a JSON round trip like supabase-js does over HTTP.
import crypto from 'crypto';
import db from '../../../backend/src/config/db.js';
import { resetRateLimits } from '../../../backend/src/middleware/rateLimit.js';
import { resetCallState } from '../../../backend/src/routes/call.js';

const CANDIDATE_STATUSES = ['invited', 'resume_uploaded', 'in_call', 'completed', 'failed'];
const CALL_STATUSES = ['in_progress', 'completed', 'failed'];
const TEXT_COLUMNS = ['invite_email_error', 'failure_reason', 'name', 'email', 'summary', 'resume_text', 'resume_path', 'recording_path', 'question_text', 'answer_text', 'company_intro'];

export class FakeDbError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const tick = () => new Promise(r => setImmediate(r));
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const pick = (row, cols) => (row ? Object.fromEntries(cols.map(c => [c, row[c] ?? null])) : null);

export function createStore() {
  return { profiles: [], batches: [], hr_questions: [], candidates: [], calls: [], answers: [], files: new Map(), authUsers: [], logs: [], linkTokens: new Map(), clock: Date.parse('2026-11-01T09:00:00Z') };
}

/**
 * Installs the fake on `db` and returns the store for assertions.
 * @param {{ latencyMs?: number }} [opts] latencyMs = artificial delay per query (lets races interleave like a real network)
 */
export function installFakeDb({ latencyMs = 0 } = {}) {
  const s = createStore();
  // A fresh scenario: no rate-limit counters, call slots or in-flight turns left over from the last one.
  resetRateLimits();
  resetCallState();
  const wait = async () => { await tick(); if (latencyMs) await new Promise(r => setTimeout(r, latencyMs)); };
  const now = () => new Date(s.clock += 1000).toISOString();
  const uuid = () => crypto.randomUUID();

  /** JSON round trip + column checks, as PostgREST would do. */
  const sanitize = (fields) => {
    const out = clone(fields) || {};
    for (const col of TEXT_COLUMNS) {
      if (col in out && out[col] !== null && typeof out[col] !== 'string') {
        throw new FakeDbError(`invalid input syntax for type text: column ${col}`, '22P02');
      }
    }
    if ('status' in out && out.__table === 'candidates' && !CANDIDATE_STATUSES.includes(out.status)) throw new FakeDbError('candidates_status_check', '23514');
    delete out.__table;
    return out;
  };
  const batchOf = (id) => s.batches.find(b => b.id === id) || null;
  const embedBatch = (c, cols) => {
    const b = batchOf(c.batch_id);
    return { ...pick(c, cols), batch: b && pick(b, ['id', 'name', 'batch_date', 'job_role', 'company_name', 'company_intro', 'call_languages', 'job_description', 'created_by', 'status']) };
  };

  const fake = {
    async getProfile(userId) { await wait(); return clone(pick(s.profiles.find(p => p.id === userId), ['id', 'name', 'email', 'role'])); },
    async getProfileByEmail(email) {
      await wait();
      return clone(pick(s.profiles.find(p => p.email === String(email).trim().toLowerCase()), ['id', 'name', 'email', 'role']));
    },
    async getCandidate(id) {
      await wait();
      const c = s.candidates.find(x => x.id === id);
      return c ? clone(embedBatch(c, ['id', 'batch_id', 'user_id', 'name', 'email', 'status', 'resume_path', 'ats_score', 'ats_breakdown'])) : null;
    },
    async getCandidateForUser(userId) {
      await wait();
      const rows = s.candidates.filter(c => c.user_id === userId && batchOf(c.batch_id)?.status !== 'draft')
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return rows[0] ? clone(embedBatch(rows[0], ['id', 'batch_id', 'name', 'email', 'status', 'failure_reason', 'consent_at', 'resume_path', 'resume_questions', 'is_fresher'])) : null;
    },
    async claimCandidatesByEmail(userId, email) {
      await wait();
      if (!email) return 0;
      const rows = s.candidates.filter(c => c.email === String(email).trim().toLowerCase() && !c.user_id);
      rows.forEach(c => { c.user_id = userId; });
      return rows.length;
    },
    async hasLiveScreening(email) {
      await wait();
      return s.candidates.some(c => c.email === String(email).trim().toLowerCase() && batchOf(c.batch_id)?.status === 'live');
    },
    async listCandidatesByEmail(email) {
      await wait();
      return clone(s.candidates.filter(c => c.email === String(email).trim().toLowerCase())
        .map(c => ({ ...pick(c, ['id', 'batch_id', 'user_id']), batch: pick(batchOf(c.batch_id), ['id', 'created_by']) })));
    },
    async linkCandidateUser(candidateId, userId) { await wait(); const c = s.candidates.find(x => x.id === candidateId); if (c) c.user_id = userId; },

    async listBatches({ ownerId } = {}) {
      await wait();
      return clone(s.batches.filter(b => !ownerId || b.created_by === ownerId).map(b => {
        const counts = { total: 0, invited: 0, resume_uploaded: 0, in_call: 0, completed: 0, failed: 0 };
        for (const c of s.candidates.filter(x => x.batch_id === b.id)) { counts.total += 1; counts[c.status] += 1; }
        return { ...b, counts };
      }));
    },
    async getBatch(id) { await wait(); return clone(batchOf(id)); },
    async createBatch(fields) {
      await wait();
      const row = { id: uuid(), status: 'draft', batch_date: new Date(s.clock).toISOString().slice(0, 10), company_name: null, company_intro: null, call_languages: ['mixed', 'en', 'hi'], scheduled_at: null, closes_at: null, job_description: null, launched_at: null, closed_at: null, created_at: now(), ...sanitize(fields) };
      s.batches.push(row);
      return clone(row);
    },
    async updateBatch(id, fields) { await wait(); const b = batchOf(id); if (!b) return null; Object.assign(b, sanitize(fields)); return clone(b); },
    async updateBatchIfStatus(id, status, fields) {
      await wait();
      const b = batchOf(id);
      if (!b || b.status !== status) return null;
      Object.assign(b, sanitize(fields));
      return clone(b);
    },
    async listDueSchedules(nowIso) {
      await wait();
      const now = Date.parse(nowIso);
      return clone({
        starting: s.batches.filter(b => b.status === 'draft' && b.scheduled_at && Date.parse(b.scheduled_at) <= now),
        closing: s.batches.filter(b => b.status === 'live' && b.closes_at && Date.parse(b.closes_at) <= now)
      });
    },
    async deleteBatch(id) {
      await wait();
      const candIds = s.candidates.filter(c => c.batch_id === id).map(c => c.id);
      const callIds = s.calls.filter(k => candIds.includes(k.candidate_id)).map(k => k.id);
      s.answers = s.answers.filter(a => !callIds.includes(a.call_id));
      s.calls = s.calls.filter(k => !callIds.includes(k.id));
      s.candidates = s.candidates.filter(c => c.batch_id !== id);
      s.hr_questions = s.hr_questions.filter(q => q.batch_id !== id);
      s.batches = s.batches.filter(b => b.id !== id);
    },

    async listQuestions(batchId) { await wait(); return clone(s.hr_questions.filter(q => q.batch_id === batchId).sort((a, b) => a.position - b.position)); },
    async getQuestion(id) { await wait(); return clone(s.hr_questions.find(q => q.id === id) || null); },
    async addQuestions(batchId, questions) {
      // Same two steps as the real code: read the last position, then insert (not atomic).
      await wait();
      const last = s.hr_questions.filter(q => q.batch_id === batchId).sort((a, b) => b.position - a.position)[0];
      const start = last ? last.position + 1 : 0;
      await wait();
      const rows = questions.map((q, i) => ({ id: uuid(), batch_id: batchId, question_text: q.question_text, answer_type: q.answer_type, position: start + i, created_at: now() }));
      for (const r of rows) {
        if (s.hr_questions.some(q => q.batch_id === batchId && q.position === r.position)) {
          throw new FakeDbError('duplicate key value violates unique constraint "hr_questions_batch_id_position_key"', '23505');
        }
      }
      s.hr_questions.push(...rows);
      return clone(rows);
    },
    async updateQuestion(id, fields) { await wait(); const q = s.hr_questions.find(x => x.id === id); if (!q) return null; Object.assign(q, sanitize(fields)); return clone(q); },
    async deleteQuestion(id) { await wait(); s.hr_questions = s.hr_questions.filter(q => q.id !== id); },
    async reorderQuestions(batchId, ids) {
      for (const [i, id] of ids.entries()) { await wait(); const q = s.hr_questions.find(x => x.id === id && x.batch_id === batchId); if (q) q.position = 10000 + i; }
      for (const [i, id] of ids.entries()) { await wait(); const q = s.hr_questions.find(x => x.id === id && x.batch_id === batchId); if (q) q.position = i; }
      return fake.listQuestions(batchId);
    },

    async listCandidates(batchId) {
      await wait();
      return clone(s.candidates.filter(c => c.batch_id === batchId).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .map(c => pick(c, ['id', 'batch_id', 'user_id', 'name', 'email', 'status', 'failure_reason', 'resume_path', 'ats_score', 'ats_breakdown', 'invite_email_sent_at', 'invite_email_error', 'created_at', 'updated_at'])));
    },
    async listResumesWithoutAts(batchId) {
      await wait();
      return clone(s.candidates.filter(c => c.batch_id === batchId && c.resume_path && (c.ats_score === undefined || c.ats_score === null)).map(c => pick(c, ['id', 'resume_text'])));
    },
    async countCandidates(batchId) { await wait(); return s.candidates.filter(c => c.batch_id === batchId).length; },
    async addCandidates(batchId, rows) {
      await wait();
      const inserted = [];
      for (const r of rows) {
        if (s.candidates.some(c => c.batch_id === batchId && c.email === r.email)) continue;
        const row = { id: uuid(), batch_id: batchId, user_id: null, name: r.name, email: r.email, status: 'invited', failure_reason: null, resume_path: null, resume_text: null, resume_questions: null, consent_at: null, invite_email_sent_at: null, invite_email_error: null, created_at: now(), updated_at: null };
        s.candidates.push(row);
        inserted.push(pick(row, ['id', 'batch_id', 'user_id', 'name', 'email', 'status', 'created_at']));
      }
      return clone(inserted);
    },
    async updateCandidate(id, fields) {
      await wait();
      const c = s.candidates.find(x => x.id === id);
      if (!c) throw new FakeDbError('JSON object requested, multiple (or no) rows returned', 'PGRST116');
      Object.assign(c, sanitize({ ...fields, __table: 'candidates' }), { updated_at: now() });
      return clone(pick(c, ['id', 'status', 'consent_at', 'resume_path']));
    },
    async uploadFile(bucket, path, data, contentType) {
      await wait();
      // Buffers (resumes) or file-backed Blobs (recordings, streamed from disk). Like real storage, a Blob is
      // not loaded whole: only its size and first bytes are read, so memory tests measure the server, not the fake.
      const bytes = Buffer.isBuffer(data) ? data.length : data.size;
      const head = Buffer.isBuffer(data) ? data.subarray(0, 16) : Buffer.from(await data.slice(0, 16).arrayBuffer());
      s.files.set(`${bucket}/${path}`, { bytes, contentType, head: head.toString('latin1') });
      return path;
    },
    async updateCandidateDetails(id, fields) {
      await wait();
      const c = s.candidates.find(x => x.id === id);
      if (!c) return;
      const clean = sanitize(fields);
      if (clean.email && s.candidates.some(x => x.id !== id && x.batch_id === c.batch_id && x.email === clean.email)) {
        throw new FakeDbError('duplicate key value violates unique constraint "candidates_batch_id_email_key"', '23505');
      }
      Object.assign(c, clean, { updated_at: now() });
    },
    async removeBatchFiles(batchId) {
      await wait();
      let removed = 0;
      for (const key of [...s.files.keys()]) {
        if (key.startsWith(`resumes/${batchId}/`) || key.startsWith(`recordings/${batchId}/`)) { s.files.delete(key); removed += 1; }
      }
      return removed;
    },
    async markInviteEmail(id, fields) {
      await wait();
      const c = s.candidates.find(x => x.id === id);
      if (c) Object.assign(c, sanitize(fields));
    },
    async deleteCandidate(id) { await wait(); s.candidates = s.candidates.filter(c => c.id !== id); },
    async updateCandidateIfStatus(id, fromStatus, fields) {
      await wait();
      const c = s.candidates.find(x => x.id === id && x.status === fromStatus);
      if (!c) return null;
      Object.assign(c, sanitize({ ...fields, __table: 'candidates' }), { updated_at: now() });
      return clone(pick(c, ['id', 'status']));
    },

    async createCall({ candidateId, questionPlan }) {
      await wait();
      const row = { id: uuid(), candidate_id: candidateId, status: 'in_progress', question_plan: clone(questionPlan), transcript: [], recording_path: null, summary: null, fit_score: null, failure_reason: null, started_at: now(), ended_at: null };
      s.calls.push(row);
      return clone(row);
    },
    async getCall(id) { await wait(); return clone(s.calls.find(k => k.id === id) || null); },
    async getLatestCallForCandidate(candidateId) {
      await wait();
      return clone(s.calls.filter(k => k.candidate_id === candidateId).sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] || null);
    },
    async getActiveCallForCandidate(candidateId) {
      await wait();
      return clone(s.calls.filter(k => k.candidate_id === candidateId && k.status === 'in_progress').sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))[0] || null);
    },
    async updateCall(id, fields) {
      await wait();
      const k = s.calls.find(x => x.id === id);
      if (!k) throw new FakeDbError('no rows', 'PGRST116');
      const clean = sanitize(fields);
      if ('status' in clean && !CALL_STATUSES.includes(clean.status)) throw new FakeDbError('calls_status_check', '23514');
      Object.assign(k, clean);
      return clone(k);
    },
    async upsertAnswer(callId, answer) {
      await wait();
      const clean = sanitize(answer);
      const existing = s.answers.find(a => a.call_id === callId && a.position === clean.position);
      if (existing) Object.assign(existing, clean);
      else s.answers.push({ id: uuid(), call_id: callId, ...clean, created_at: now() });
      return clone(s.answers.find(a => a.call_id === callId && a.position === clean.position));
    },
    async listAnswers(callId) { await wait(); return clone(s.answers.filter(a => a.call_id === callId).sort((a, b) => a.position - b.position)); },
    async listCallsForCandidates(ids) {
      await wait();
      return clone(s.calls.filter(k => ids.includes(k.candidate_id)).map(k => pick(k, ['id', 'candidate_id', 'status', 'recording_path', 'summary', 'fit_score', 'failure_reason', 'started_at', 'ended_at'])));
    },
    async listAnswersForCalls(ids) { await wait(); return clone(s.answers.filter(a => ids.includes(a.call_id)).sort((a, b) => a.position - b.position)); },
    async signedUrl(bucket, path, seconds) { await wait(); return `http://qa.localhost/signed/${bucket}/${path}?expires=${seconds}`; },
    async listCandidatesForBatches(ids) {
      await wait();
      return clone(s.candidates.filter(c => ids.includes(c.batch_id)).map(c => pick(c, ['id', 'batch_id', 'name', 'email', 'status', 'created_at'])));
    },
    async listStaff() { await wait(); return clone(s.profiles.filter(p => ['superadmin', 'recruiter'].includes(p.role))); },
    async updateProfile(id, fields) { await wait(); const p = s.profiles.find(x => x.id === id); if (!p) return null; Object.assign(p, sanitize(fields)); return clone(pick(p, ['id', 'name', 'email', 'role'])); },
    async reassignBatches(from, to) { await wait(); s.batches.filter(b => b.created_by === from).forEach(b => { b.created_by = to; }); }
  };

  // Supabase client surface used directly by routes (invite links, team accounts) and the call logger.
  const authUserFor = (email, meta = {}) => {
    let u = s.authUsers.find(x => x.email === email);
    if (!u) {
      u = { id: uuid(), email, user_metadata: meta };
      s.authUsers.push(u);
      // handle_new_user trigger: every new auth user gets a candidate profile.
      s.profiles.push({ id: u.id, email, name: meta.name || null, role: 'candidate', created_at: now() });
    }
    return u;
  };
  const supabase = {
    auth: {
      async getUser() { return { data: null, error: new Error('QA: real tokens are not accepted, use test tokens') }; },
      admin: {
        async generateLink({ email, options }) {
          const user = authUserFor(email, options?.data);
          const hashed = `qa-hash-${uuid()}`;
          s.linkTokens.set(hashed, user.id);
          return { data: { user, properties: { hashed_token: hashed, action_link: `http://qa.localhost/auth/v1/verify?token=${uuid()}&type=magiclink&redirect_to=${encodeURIComponent(options?.redirectTo || '')}` } }, error: null };
        },
        async createUser({ email, user_metadata }) {
          if (s.authUsers.some(u => u.email === email)) return { data: null, error: new Error('User already registered') };
          return { data: { user: authUserFor(email, user_metadata) }, error: null };
        },
        async deleteUser(id) {
          s.authUsers = s.authUsers.filter(u => u.id !== id);
          s.profiles = s.profiles.filter(p => p.id !== id);
          return { error: null };
        }
      }
    },
    from(table) { return { insert: async (rows) => { if (table === 'external_call_logs') s.logs.push(...rows); return { error: null }; } }; }
  };

  // Server-side sign-in (db.exchangeLinkToken / db.signInWithGoogleIdToken). Sessions are QA test tokens.
  const session = (u) => ({ accessToken: `test:candidate:${u.id}:${u.email}`, user: { id: u.id, email: u.email } });
  fake.exchangeLinkToken = async (hash) => {
    await wait();
    const id = s.linkTokens.get(hash);
    s.linkTokens.delete(hash); // one use, like Supabase
    const u = s.authUsers.find(x => x.id === id);
    if (!u) throw Object.assign(new Error('The sign-in link could not be used.'), { status: 502 });
    return session(u);
  };
  // A fake Google ID token is valid when signed "qa-google-sig" and its nonce is SHA-256 of the raw nonce.
  fake.signInWithGoogleIdToken = async (idToken, nonce) => {
    await wait();
    const [, body, sig] = String(idToken).split('.');
    let payload = null;
    try { payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return null; }
    const hashed = crypto.createHash('sha256').update(String(nonce)).digest('hex');
    if (sig !== 'qa-google-sig' || payload?.nonce !== hashed || payload?.aud !== process.env.GOOGLE_CLIENT_ID) return null;
    return session(authUserFor(payload.email, { name: payload.name }));
  };

  Object.assign(db, fake, { supabase, isConfigured: true });
  s.addProfile = (p) => { s.profiles.push({ created_at: now(), name: null, ...p }); return p; };
  return s;
}
