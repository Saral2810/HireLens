import { Router } from 'express';
import db from '../config/db.js';
import multer from 'multer';
import { ROLES, HR_ROLES, clearRoleCache } from '../middleware/auth.js';
import { computeAnalytics } from '../services/analytics.js';
import { cellText, parseCsvTable, rowsFromTable } from '../services/spreadsheet.js';
import ExcelJS from 'exceljs';
import { DEFAULT_HR_QUESTIONS } from '../services/questionTemplates.js';
import { buildResultRows, exportTable, toCsv } from '../services/results.js';
import {
  validateBatchInput, validateQuestionInput, normalizeCandidateRows, MAX_CANDIDATES_PER_BATCH
} from '../utils/validation.js';

/**
 * HR API. Mounted at /api/hr behind requireAuth + requireRole('superadmin', 'recruiter').
 * Admin (superadmin) reaches every campaign; a recruiter only their own (see canManage below).
 * Phase D: invite links. Phase E: batches, questions, candidates. Phase H: results, export, retakes.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every :id is a UUID; anything else is a 404 rather than a database error.
router.param('id', (req, res, next, id) => (UUID_RE.test(id) ? next() : notFound(res, 'Item')));

const badRequest = (res, errors) => res.status(400).json({ error: 'Bad Request', message: errors.join(' '), errors });
const notFound = (res, what) => res.status(404).json({ error: 'Not Found', message: `${what} not found.` });

// ── Who can reach what (RBAC) ─────────────────────────────────────────────
// Admin (superadmin) reaches every campaign; a recruiter only the campaigns they created.
// Anything outside the user's reach answers 404, so ids of other people's campaigns are not confirmed.

export function canManage(user, batch) {
  return !!batch && (user?.role === ROLES.SUPERADMIN || batch.created_by === user?.id);
}

const adminOnly = (req, res, next) => (req.user?.role === ROLES.SUPERADMIN
  ? next()
  : res.status(403).json({ error: 'Forbidden', message: 'Only an Admin can do this.' }));

function guard(load, what) {
  return async (req, res, next) => {
    try {
      const batch = await load(req.params.id);
      if (!canManage(req.user, batch)) return notFound(res, what);
      next();
    } catch (err) { next(err); }
  };
}

router.use('/batches/:id', guard(id => db.getBatch(id), 'Campaign'));
router.use('/questions/:id', guard(async id => {
  const q = await db.getQuestion(id);
  return q && db.getBatch(q.batch_id);
}, 'Question'));
router.use('/candidates/:id', guard(async id => {
  const c = await db.getCandidate(id);
  return c && db.getBatch(c.batch_id);
}, 'Candidate'));
router.use('/calls/:id', guard(async id => {
  const call = await db.getCall(id);
  const c = call && await db.getCandidate(call.candidate_id);
  return c && db.getBatch(c.batch_id);
}, 'Call'));

/** Where invite links land. PUBLIC_APP_URL wins; otherwise the address HR is using. */
function appUrl(req) {
  const configured = (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  return configured || `${req.protocol}://${req.get('host')}`;
}

/**
 * Creates (or reuses) the candidate's login and returns a one-time sign-in link.
 * No email is sent: contest candidates are made up and have no real inbox.
 */
async function createInviteLink(candidate, req) {
  // Never hand out a link that signs someone in as an HR account.
  const existing = await db.getProfileByEmail(candidate.email);
  if (existing?.role === ROLES.SUPERADMIN) {
    const err = new Error('This email belongs to an HR account. Use a different candidate email.');
    err.status = 409;
    throw err;
  }

  // generateLink creates the auth user on first use; the profiles trigger makes it a candidate.
  const { data, error } = await db.supabase.auth.admin.generateLink({
    type: 'magiclink',
    email: candidate.email,
    options: { redirectTo: `${appUrl(req)}/invite`, data: { name: candidate.name } }
  });
  if (error) throw error;

  if (candidate.user_id !== data.user.id) {
    await db.linkCandidateUser(candidate.id, data.user.id);
  }
  return data.properties.action_link;
}

// ── Batches ───────────────────────────────────────────────────────────────

router.get('/batches', async (req, res, next) => {
  try {
    res.json(await db.listBatches(req.user.role === ROLES.SUPERADMIN ? {} : { ownerId: req.user.id }));
  } catch (err) { next(err); }
});

router.post('/batches', async (req, res, next) => {
  try {
    const { value, errors } = validateBatchInput(req.body);
    if (errors.length) return badRequest(res, errors);
    const batch = await db.createBatch({ ...value, created_by: req.user.id });
    res.status(201).json(batch);
  } catch (err) { next(err); }
});

/** One batch with its questions and candidates. */
router.get('/batches/:id', async (req, res, next) => {
  try {
    const batch = await db.getBatch(req.params.id);
    if (!batch) return notFound(res, 'Batch');
    const [questions, candidates] = await Promise.all([db.listQuestions(batch.id), db.listCandidates(batch.id)]);
    res.json({ ...batch, questions, candidates });
  } catch (err) { next(err); }
});

router.patch('/batches/:id', async (req, res, next) => {
  try {
    const { value, errors } = validateBatchInput(req.body, { partial: true });
    if (errors.length) return badRequest(res, errors);
    const batch = await db.updateBatch(req.params.id, value);
    if (!batch) return notFound(res, 'Batch');
    res.json(batch);
  } catch (err) { next(err); }
});

/** Deleting is allowed only before any candidate has started, so no screening data is lost. */
router.delete('/batches/:id', async (req, res, next) => {
  try {
    const batch = await db.getBatch(req.params.id);
    if (!batch) return notFound(res, 'Batch');
    const started = (await db.listCandidates(batch.id)).filter(c => c.status !== 'invited');
    if (started.length) {
      return res.status(409).json({ error: 'Conflict', message: `${started.length} candidate(s) in this batch have already started. The batch cannot be deleted.` });
    }
    await db.deleteBatch(batch.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── HR questions ──────────────────────────────────────────────────────────

router.post('/batches/:id/questions', async (req, res, next) => {
  try {
    const { value, errors } = validateQuestionInput(req.body);
    if (errors.length) return badRequest(res, errors);
    if (!(await db.getBatch(req.params.id))) return notFound(res, 'Batch');
    const [question] = await db.addQuestions(req.params.id, [value]);
    res.status(201).json(question);
  } catch (err) { next(err); }
});

/** Adds the default questions (notice period, CTC, location, joining) that are not in the batch yet. */
router.post('/batches/:id/questions/defaults', async (req, res, next) => {
  try {
    if (!(await db.getBatch(req.params.id))) return notFound(res, 'Batch');
    const current = new Set((await db.listQuestions(req.params.id)).map(q => q.question_text.toLowerCase()));
    const missing = DEFAULT_HR_QUESTIONS.filter(q => !current.has(q.question_text.toLowerCase()));
    if (missing.length) await db.addQuestions(req.params.id, missing);
    res.json({ added: missing.length, questions: await db.listQuestions(req.params.id) });
  } catch (err) { next(err); }
});

/** PUT { ids: [questionId, ...] } in the new order. Must list every question of the batch once. */
router.put('/batches/:id/questions/order', async (req, res, next) => {
  try {
    const ids = req.body?.ids;
    const current = await db.listQuestions(req.params.id);
    const sameSet = Array.isArray(ids) && ids.length === current.length && new Set(ids).size === ids.length
      && ids.every(id => current.some(q => q.id === id));
    if (!sameSet) return badRequest(res, ['ids must list every question of this batch exactly once.']);
    res.json(await db.reorderQuestions(req.params.id, ids));
  } catch (err) { next(err); }
});

router.patch('/questions/:id', async (req, res, next) => {
  try {
    const { value, errors } = validateQuestionInput(req.body, { partial: true });
    if (errors.length) return badRequest(res, errors);
    const question = await db.updateQuestion(req.params.id, value);
    if (!question) return notFound(res, 'Question');
    res.json(question);
  } catch (err) { next(err); }
});

router.delete('/questions/:id', async (req, res, next) => {
  try {
    if (!(await db.getQuestion(req.params.id))) return notFound(res, 'Question');
    await db.deleteQuestion(req.params.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Candidates ────────────────────────────────────────────────────────────

/**
 * POST { candidates: [{ name, email }, ...] }
 * Adds candidates (up to 100 per batch). Bad rows are reported and nothing is added until they are fixed;
 * emails already in the batch are skipped.
 */
router.post('/batches/:id/candidates', async (req, res, next) => {
  try {
    if (!(await db.getBatch(req.params.id))) return notFound(res, 'Batch');
    const { valid, errors } = normalizeCandidateRows(req.body?.candidates);
    if (errors.length) {
      return res.status(400).json({ error: 'Bad Request', message: `${errors.length} row(s) need fixing.`, row_errors: errors });
    }
    if (!valid.length) return badRequest(res, ['Add at least one candidate.']);

    const existing = await db.countCandidates(req.params.id);
    if (existing + valid.length > MAX_CANDIDATES_PER_BATCH) {
      return badRequest(res, [`A batch holds at most ${MAX_CANDIDATES_PER_BATCH} candidates. It has ${existing}; you tried to add ${valid.length}.`]);
    }

    const inserted = await db.addCandidates(req.params.id, valid);
    res.status(201).json({ added: inserted.length, skipped_existing: valid.length - inserted.length, candidates: inserted });
  } catch (err) { next(err); }
});

/** Only candidates who have not started can be removed. */
router.delete('/candidates/:id', async (req, res, next) => {
  try {
    const candidate = await db.getCandidate(req.params.id);
    if (!candidate) return notFound(res, 'Candidate');
    if (candidate.status !== 'invited') {
      return res.status(409).json({ error: 'Conflict', message: 'This candidate has already started and cannot be removed.' });
    }
    await db.deleteCandidate(candidate.id);
    res.status(204).end();
  } catch (err) { next(err); }
});

/** POST /api/hr/candidates/:id/invite-link → one-time sign-in link for one candidate. */
router.post('/candidates/:id/invite-link', async (req, res, next) => {
  try {
    const candidate = await db.getCandidate(req.params.id);
    if (!candidate) return notFound(res, 'Candidate');
    const inviteLink = await createInviteLink(candidate, req);
    res.json({
      candidate_id: candidate.id,
      email: candidate.email,
      invite_link: inviteLink,
      note: 'Works once. Generate a new link if it has been used or has expired.'
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/hr/batches/:id/invite-links { candidate_ids?: [...] }
 * Links for several candidates (default: everyone who has not finished). One failure does not stop the rest.
 */
router.post('/batches/:id/invite-links', async (req, res, next) => {
  try {
    if (!(await db.getBatch(req.params.id))) return notFound(res, 'Batch');
    const wanted = Array.isArray(req.body?.candidate_ids) ? new Set(req.body.candidate_ids) : null;
    const candidates = (await db.listCandidates(req.params.id))
      .filter(c => (wanted ? wanted.has(c.id) : !['completed', 'failed'].includes(c.status)));

    const links = [];
    for (const candidate of candidates) {
      try {
        links.push({ candidate_id: candidate.id, name: candidate.name, email: candidate.email, invite_link: await createInviteLink(candidate, req) });
      } catch (err) {
        links.push({ candidate_id: candidate.id, name: candidate.name, email: candidate.email, error: err.message });
      }
    }
    res.json({ links, note: 'Each link works once. Generate new links for anyone whose link has been used or has expired.' });
  } catch (err) { next(err); }
});

/** POST /api/hr/candidates/:id/allow-retake → a failed candidate may take the call again. */
router.post('/candidates/:id/allow-retake', async (req, res, next) => {
  try {
    const candidate = await db.getCandidate(req.params.id);
    if (!candidate) return notFound(res, 'Candidate');
    if (candidate.status !== 'failed') {
      return res.status(409).json({ error: 'Conflict', message: 'Only a candidate whose call did not finish can retake it.' });
    }
    // Earlier calls and answers are kept; the results show the newest call.
    const updated = await db.updateCandidate(candidate.id, { status: candidate.resume_path ? 'resume_uploaded' : 'invited', failure_reason: null });
    res.json({ candidate_id: candidate.id, status: updated.status, note: 'The candidate can open the portal and start the call again. Send a new invite link if they are signed out.' });
  } catch (err) { next(err); }
});

// ── Results (Phase H) ─────────────────────────────────────────────────────

// Recording and resume links stop working after 10 minutes.
const SIGNED_URL_SECONDS = 10 * 60;

async function loadResults(batch) {
  const [questions, candidates] = await Promise.all([db.listQuestions(batch.id), db.listCandidates(batch.id)]);
  const calls = await db.listCallsForCandidates(candidates.map(c => c.id));
  const answers = await db.listAnswersForCalls(calls.map(c => c.id));
  return { questions, rows: buildResultRows({ candidates, calls, answers }) };
}

/** GET /api/hr/batches/:id/results → { batch, questions, rows } (one row per candidate, newest call). */
router.get('/batches/:id/results', async (req, res, next) => {
  try {
    const batch = await db.getBatch(req.params.id);
    if (!batch) return notFound(res, 'Batch');
    res.json({ batch, ...(await loadResults(batch)) });
  } catch (err) { next(err); }
});

/**
 * GET /api/hr/calls/:id → the whole call: answers, transcript, and 10-minute links to the
 * recording and the resume.
 */
router.get('/calls/:id', async (req, res, next) => {
  try {
    const call = await db.getCall(req.params.id);
    if (!call) return notFound(res, 'Call');
    const [candidate, answers] = await Promise.all([db.getCandidate(call.candidate_id), db.listAnswers(call.id)]);
    const link = (bucket, path) => (path ? db.signedUrl(bucket, path, SIGNED_URL_SECONDS).catch(() => null) : null);
    const [recordingUrl, resumeUrl] = await Promise.all([link('recordings', call.recording_path), link('resumes', candidate?.resume_path)]);
    const [row] = buildResultRows({ candidates: [candidate], calls: [call], answers });
    res.json({
      ...row,
      transcript: call.transcript || [],
      recording_url: recordingUrl,
      resume_url: resumeUrl,
      links_expire_in_seconds: SIGNED_URL_SECONDS
    });
  } catch (err) { next(err); }
});

/** GET /api/hr/batches/:id/export?format=csv|xlsx → file download of the results table. */
router.get('/batches/:id/export', async (req, res, next) => {
  try {
    const format = String(req.query.format || 'csv').toLowerCase();
    if (!['csv', 'xlsx'].includes(format)) return badRequest(res, ['format must be csv or xlsx.']);
    const batch = await db.getBatch(req.params.id);
    if (!batch) return notFound(res, 'Batch');
    const { questions, rows } = await loadResults(batch);
    const table = exportTable(rows, questions);
    const base = `${batch.name}-${batch.batch_date}`.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'results';
    res.set('Content-Disposition', `attachment; filename="${base}.${format}"`);

    if (format === 'csv') {
      res.type('text/csv; charset=utf-8').send(toCsv(table));
      return;
    }
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('Results', { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.addRow(table.headers).font = { bold: true };
    table.rows.forEach(r => sheet.addRow(r));
    sheet.columns.forEach((col, i) => {
      const longest = Math.max(...[table.headers[i], ...table.rows.map(r => r[i])].map(v => String(v ?? '').split('\n')[0].length));
      col.width = Math.min(60, Math.max(10, longest + 2));
      col.alignment = { vertical: 'top', wrapText: true };
    });
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(Buffer.from(await book.xlsx.writeBuffer()));
  } catch (err) { next(err); }
});


// ── Campaign lifecycle (UI rebuild) ───────────────────────────────────────

/** POST /api/hr/batches/:id/run → campaign live: candidates can sign in and take the call. */
router.post('/batches/:id/run', async (req, res, next) => {
  try {
    const batch = await db.getBatch(req.params.id);
    if (batch.status === 'live') return res.json(batch);
    if (!(await db.countCandidates(batch.id))) return badRequest(res, ['Add at least one candidate before running the campaign.']);
    res.json(await db.updateBatch(batch.id, { status: 'live', launched_at: batch.launched_at || new Date().toISOString(), closed_at: null }));
  } catch (err) { next(err); }
});

/** POST /api/hr/batches/:id/close → no new calls can start; finished results stay. */
router.post('/batches/:id/close', async (req, res, next) => {
  try {
    res.json(await db.updateBatch(req.params.id, { status: 'closed', closed_at: new Date().toISOString() }));
  } catch (err) { next(err); }
});

// ── Dashboard analytics ───────────────────────────────────────────────────

/** GET /api/hr/analytics → numbers for every campaign the user can see. */
router.get('/analytics', async (req, res, next) => {
  try {
    const batches = await db.listBatches(req.user.role === ROLES.SUPERADMIN ? {} : { ownerId: req.user.id });
    const candidates = await db.listCandidatesForBatches(batches.map(b => b.id));
    const calls = await db.listCallsForCandidates(candidates.map(c => c.id));
    res.json(computeAnalytics({ batches, candidates, calls }));
  } catch (err) { next(err); }
});

// ── Candidate spreadsheet upload ──────────────────────────────────────────

const sheetUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } });

/**
 * POST /api/hr/parse-candidates (multipart "file": .xlsx or .csv)
 * → { rows: [{ name, email }], columns: { name, email } } read from the first sheet.
 * Nothing is saved; the client shows a preview and then adds the rows.
 */
router.post('/parse-candidates', sheetUpload.single('file'), async (req, res, next) => {
  try {
    if (!req.file?.buffer?.length) return badRequest(res, ['Choose an Excel (.xlsx) or CSV file.']);
    const name = (req.file.originalname || '').toLowerCase();
    let table;
    if (name.endsWith('.csv') || req.file.mimetype === 'text/csv') {
      table = parseCsvTable(req.file.buffer.toString('utf8'));
    } else if (name.endsWith('.xlsx')) {
      const book = new ExcelJS.Workbook();
      try { await book.xlsx.load(req.file.buffer); } catch { return badRequest(res, ['This file could not be read as an Excel workbook.']); }
      const sheet = book.worksheets[0];
      table = [];
      sheet?.eachRow({ includeEmpty: false }, row => {
        table.push(row.values.slice(1).map(v => cellText(v)));
      });
    } else {
      return badRequest(res, ['Use an .xlsx or .csv file.']);
    }
    const result = rowsFromTable(table);
    if (result.error) return badRequest(res, [result.error]);
    res.json(result);
  } catch (err) { next(err); }
});

// ── Team (Admin only) ─────────────────────────────────────────────────────

router.get('/team', adminOnly, async (req, res, next) => {
  try {
    const [staff, batches] = await Promise.all([db.listStaff(), db.listBatches()]);
    const owned = {};
    for (const b of batches) owned[b.created_by] = (owned[b.created_by] || 0) + 1;
    res.json(staff.map(s => ({ ...s, campaigns: owned[s.id] || 0, is_you: s.id === req.user.id })));
  } catch (err) { next(err); }
});

/** POST /api/hr/team { name, email, password, role } → creates an HR account (signs in with this password). */
router.post('/team', adminOnly, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const role = req.body?.role === ROLES.SUPERADMIN ? ROLES.SUPERADMIN : ROLES.RECRUITER;
    const errors = [];
    if (!name) errors.push('Name is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.push('Enter a valid email.');
    if (password.length < 8) errors.push('The password needs at least 8 characters.');
    if (errors.length) return badRequest(res, errors);

    const existing = await db.getProfileByEmail(email);
    if (existing) return res.status(409).json({ error: 'Conflict', message: 'An account with this email already exists.' });

    const { data, error } = await db.supabase.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { name } });
    if (error) throw error;
    const profile = await db.updateProfile(data.user.id, { role, name });
    res.status(201).json({ ...profile, campaigns: 0 });
  } catch (err) { next(err); }
});

/** PATCH /api/hr/team/:userId { role } → Admin ⇄ Recruiter. */
router.patch('/team/:userId', adminOnly, async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) return notFound(res, 'Account');
    if (userId === req.user.id) return badRequest(res, ['You cannot change your own role.']);
    const role = req.body?.role;
    if (!HR_ROLES.includes(role)) return badRequest(res, ['Role must be admin or recruiter.']);
    const target = await db.getProfile(userId);
    if (!target || !HR_ROLES.includes(target.role)) return notFound(res, 'Account');
    const profile = await db.updateProfile(userId, { role });
    clearRoleCache(userId);
    res.json(profile);
  } catch (err) { next(err); }
});

/** DELETE /api/hr/team/:userId → removes an HR account; its campaigns move to the Admin who removed it. */
router.delete('/team/:userId', adminOnly, async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!UUID_RE.test(userId)) return notFound(res, 'Account');
    if (userId === req.user.id) return badRequest(res, ['You cannot remove your own account.']);
    const target = await db.getProfile(userId);
    if (!target || !HR_ROLES.includes(target.role)) return notFound(res, 'Account');
    await db.reassignBatches(userId, req.user.id);
    const { error } = await db.supabase.auth.admin.deleteUser(userId);
    if (error) throw error;
    clearRoleCache(userId);
    res.status(204).end();
  } catch (err) { next(err); }
});

router.use((err, req, res, next) => {
  if (err?.name === 'MulterError') {
    return res.status(400).json({ error: 'Bad Request', message: err.code === 'LIMIT_FILE_SIZE' ? 'The file is larger than 2 MB.' : 'Upload one file.' });
  }
  next(err);
});

export default router;
