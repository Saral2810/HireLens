import { Router } from 'express';
import db from '../config/db.js';
import multer from 'multer';
import { ROLES, HR_ROLES, clearRoleCache } from '../middleware/auth.js';
import { limits } from '../middleware/rateLimit.js';
import { computeAnalytics } from '../services/analytics.js';
import { cellText, parseCsvTable, rowsFromTable } from '../services/spreadsheet.js';
import ExcelJS from 'exceljs';
import { DEFAULT_HR_QUESTIONS } from '../services/questionTemplates.js';
import { buildResultRows, exportTable, toCsv } from '../services/results.js';
import { appUrl, createInviteLink, sendInviteEmail, queueInviteEmails } from '../services/candidateInvites.js';
import { isMailConfigured, missingMailSettings } from '../services/mailer.js';
import { prevoiceCampaign, prevoiceEnabled } from '../services/prevoice.js';
import { validateSchedule } from '../services/campaignScheduler.js';
import {
  validateBatchInput, validateQuestionInput, normalizeCandidateRows, MAX_CANDIDATES_PER_BATCH
} from '../utils/validation.js';

/**
 * HR API. Mounted at /api/hr behind requireAuth + requireRole('superadmin', 'recruiter').
 * Admin (superadmin) reaches every campaign; a recruiter only their own (see canManage below).
 * Phase D: invite links. Phase E: batches, questions, candidates. Phase H: results, export, retakes.
 * Invite emails: running a campaign (or adding people to a live one) emails each candidate a personal link.
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
    res.json({ ...batch, questions, candidates, email: { configured: isMailConfigured() } });
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

/**
 * DELETE /api/hr/batches/:id { confirm_name? } → { deleted, candidates, files_removed }
 * Before anyone has started, a campaign is deleted straight away. Once candidates have resumes, calls
 * or results, HR must type the campaign name (confirm_name), and the campaign must not be live, so
 * nobody is mid-call. Questions, candidates, calls and answers go by cascade; resumes and recordings
 * are removed from storage too.
 */
router.delete('/batches/:id', async (req, res, next) => {
  try {
    const batch = await db.getBatch(req.params.id);
    if (!batch) return notFound(res, 'Batch');
    const candidates = await db.listCandidates(batch.id);
    const started = candidates.filter(c => c.status !== 'invited');
    if (started.length) {
      if (batch.status === 'live' || started.some(c => c.status === 'in_call')) {
        return res.status(409).json({ error: 'Conflict', message: `${started.length} candidate(s) have already started. Close the campaign first, so nobody is in a call, then delete it.` });
      }
      if (String(req.body?.confirm_name ?? '').trim() !== batch.name) {
        return res.status(400).json({
          error: 'Bad Request', code: 'confirm_required', started: started.length,
          message: `This deletes ${started.length} candidate(s)' resumes, recordings and results for good. Type the campaign name to confirm.`
        });
      }
    }
    const filesRemoved = await db.removeBatchFiles(batch.id);
    await db.deleteBatch(batch.id);
    res.json({ deleted: true, candidates: candidates.length, files_removed: filesRemoved });
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
    // People added to a campaign that is already running get their invite email straight away.
    const batch = await db.getBatch(req.params.id);
    const emails = batch.status === 'live' ? queueInviteEmails(batch, inserted, appUrl(req)) : { configured: isMailConfigured(), queued: 0 };
    res.status(201).json({
      added: inserted.length, skipped_existing: valid.length - inserted.length, candidates: inserted,
      emails: { configured: emails.configured, queued: emails.queued }
    });
  } catch (err) { next(err); }
});

/**
 * PATCH /api/hr/candidates/:id { name?, email? } → the updated row.
 * The name can be corrected any time. The email only before the candidate has started; a new email
 * clears the old sign-in link and, if the campaign is live, the invite goes to the new address.
 */
router.patch('/candidates/:id', async (req, res, next) => {
  try {
    const candidate = await db.getCandidate(req.params.id);
    if (!candidate) return notFound(res, 'Candidate');
    const { valid, errors } = normalizeCandidateRows([{ name: req.body?.name ?? candidate.name, email: req.body?.email ?? candidate.email }]);
    if (errors.length) return badRequest(res, errors.map(e => e.message));
    const { name, email } = valid[0];
    const emailChanged = email !== candidate.email;
    if (!emailChanged && name === candidate.name) return badRequest(res, ['Nothing to update.']);

    const fields = { name };
    if (emailChanged) {
      if (candidate.status !== 'invited') {
        return res.status(409).json({ error: 'Conflict', message: 'This candidate has already started, so the email can no longer be changed.' });
      }
      if ((await db.listCandidates(candidate.batch_id)).some(c => c.id !== candidate.id && c.email === email)) {
        return res.status(409).json({ error: 'Conflict', message: `${email} is already in this campaign.` });
      }
      Object.assign(fields, { email, user_id: null, invite_email_sent_at: null, invite_email_error: null });
    }
    await db.updateCandidateDetails(candidate.id, fields);
    const updated = (await db.listCandidates(candidate.batch_id)).find(c => c.id === candidate.id);
    const emails = emailChanged && candidate.batch?.status === 'live'
      ? queueInviteEmails(candidate.batch, [updated], appUrl(req))
      : { configured: isMailConfigured(), queued: 0 };
    res.json({ ...updated, emails: { configured: emails.configured, queued: emails.queued } });
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
/**
 * BUG-01: a copied sign-in link signs in as whoever owns that email address, for every screening they
 * have. So HR may copy one only for a person whose screenings are all in campaigns this HR user
 * manages. Otherwise "Send email" still works: that link goes only to the person's own inbox.
 */
async function refuseForeignScreenings(user, candidate) {
  const rows = await db.listCandidatesByEmail(candidate.email);
  if (rows.some(r => r.id !== candidate.id && !canManage(user, r.batch))) {
    const err = new Error('This person also has a screening in another recruiter\'s campaign, so a copied sign-in link is not allowed. Use "Send email" instead: that link goes only to their own inbox.');
    err.status = 409;
    throw err;
  }
}

router.post('/candidates/:id/invite-link', async (req, res, next) => {
  try {
    const candidate = await db.getCandidate(req.params.id);
    if (!candidate) return notFound(res, 'Candidate');
    await refuseForeignScreenings(req.user, candidate);
    const inviteLink = await createInviteLink(candidate, appUrl(req));
    res.json({
      candidate_id: candidate.id,
      email: candidate.email,
      invite_link: inviteLink,
      note: `The candidate's personal link (the same as in their invite email). It works until it expires after ${process.env.INVITE_LINK_DAYS || 30} days.`
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
        await refuseForeignScreenings(req.user, candidate);
        links.push({ candidate_id: candidate.id, name: candidate.name, email: candidate.email, invite_link: await createInviteLink(candidate, appUrl(req)) });
      } catch (err) {
        links.push({ candidate_id: candidate.id, name: candidate.name, email: candidate.email, error: err.message });
      }
    }
    res.json({ links, note: 'Personal links (the same as in the invite emails). Each works until it expires.' });
  } catch (err) { next(err); }
});

/**
 * POST /api/hr/candidates/:id/send-invite → emails this candidate their personal link now
 * (first time, or again if it failed or they lost it). Only while the campaign is live.
 */
router.post('/candidates/:id/send-invite', limits.sendInvite, async (req, res, next) => {
  try {
    const candidate = await db.getCandidate(req.params.id);
    if (!candidate) return notFound(res, 'Candidate');
    if (!isMailConfigured()) {
      return res.status(503).json({ error: 'Email not configured', message: `Email is not set up. Add ${missingMailSettings().join(', ')} to .env (or the host's environment settings), then restart the app.` });
    }
    if (candidate.batch?.status !== 'live') {
      return res.status(409).json({ error: 'Conflict', message: 'Run the campaign first. Invites are emailed only while it is live.' });
    }
    if (candidate.status === 'completed') return res.status(409).json({ error: 'Conflict', message: 'This candidate has already finished the screening.' });
    const result = await sendInviteEmail(candidate, candidate.batch, appUrl(req));
    if (!result.sent) return res.status(502).json({ error: 'Email failed', message: result.error });
    res.json({ candidate_id: candidate.id, sent: true });
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

/** POST /api/hr/batches/:id/run → campaign live, and every candidate not emailed yet gets their invite email. */
router.post('/batches/:id/run', async (req, res, next) => {
  try {
    let batch = await db.getBatch(req.params.id);
    if (batch.status !== 'live') {
      if (!(await db.countCandidates(batch.id))) return badRequest(res, ['Add at least one candidate before running the campaign.']);
      // Running now replaces any start time set earlier; a close time already past is dropped.
      const closesAt = batch.closes_at && Date.parse(batch.closes_at) > Date.now() ? batch.closes_at : null;
      batch = await db.updateBatch(batch.id, { status: 'live', launched_at: batch.launched_at || new Date().toISOString(), closed_at: null, scheduled_at: null, closes_at: closesAt });
    }
    // Everyone not emailed yet gets their invite (running again only reaches people who never got one).
    const emails = queueInviteEmails(batch, await db.listCandidates(batch.id), appUrl(req));
    // Voice the lines every call shares (HR questions, briefing) in the background.
    if (prevoiceEnabled()) {
      const live = batch;
      db.listQuestions(live.id)
        .then(questions => prevoiceCampaign(live, questions))
        .then(r => { if (r.failed) console.warn(`[Campaign ${live.id}] Pre-voicing: ${r.voiced} lines ready, ${r.failed} failed.`); })
        .catch(err => console.warn(`[Campaign ${live.id}] Pre-voicing failed: ${err.message}`));
    }
    res.json({ ...batch, emails: { configured: emails.configured, queued: emails.queued } });
  } catch (err) { next(err); }
});

/** POST /api/hr/batches/:id/close → no new calls can start; finished results stay. */
router.post('/batches/:id/close', async (req, res, next) => {
  try {
    res.json(await db.updateBatch(req.params.id, { status: 'closed', closed_at: new Date().toISOString(), scheduled_at: null, closes_at: null }));
  } catch (err) { next(err); }
});

/**
 * POST /api/hr/batches/:id/schedule { start_at, close_at? } → the campaign
 * A draft campaign starts by itself at start_at: it goes live and every candidate is emailed their
 * invite then. close_at (optional) closes it by itself later. For a live campaign only close_at is set.
 */
router.post('/batches/:id/schedule', async (req, res, next) => {
  try {
    const batch = await db.getBatch(req.params.id);
    const { value, errors } = validateSchedule(req.body || {}, batch);
    if (errors.length) return badRequest(res, errors);
    if (batch.status === 'draft' && !(await db.countCandidates(batch.id))) {
      return badRequest(res, ['Add at least one candidate before scheduling the campaign.']);
    }
    // Status-checked: a campaign that started (or closed) in the meantime is not changed.
    const updated = await db.updateBatchIfStatus(batch.id, batch.status, value);
    if (!updated) return res.status(409).json({ error: 'Conflict', message: 'The campaign changed in the meantime. Reload the page.' });
    res.json(updated);
  } catch (err) { next(err); }
});

/** DELETE /api/hr/batches/:id/schedule → removes the start and close times (the campaign stays as it is). */
router.delete('/batches/:id/schedule', async (req, res, next) => {
  try {
    const batch = await db.getBatch(req.params.id);
    res.json(await db.updateBatch(batch.id, { scheduled_at: null, closes_at: null }));
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
router.post('/team', adminOnly, limits.teamCreate, async (req, res, next) => {
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
