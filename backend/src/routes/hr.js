import { Router } from 'express';
import db from '../config/db.js';
import { ROLES } from '../middleware/auth.js';
import { DEFAULT_HR_QUESTIONS } from '../services/questionTemplates.js';
import {
  validateBatchInput, validateQuestionInput, normalizeCandidateRows, MAX_CANDIDATES_PER_BATCH
} from '../utils/validation.js';

/**
 * HR (super-admin) API. Mounted at /api/hr behind requireAuth + requireRole('superadmin').
 * Phase D: invite links. Phase E: batches, questions, candidates. Phase H adds results.
 */
const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every :id is a UUID; anything else is a 404 rather than a database error.
router.param('id', (req, res, next, id) => (UUID_RE.test(id) ? next() : notFound(res, 'Item')));

const badRequest = (res, errors) => res.status(400).json({ error: 'Bad Request', message: errors.join(' '), errors });
const notFound = (res, what) => res.status(404).json({ error: 'Not Found', message: `${what} not found.` });

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
    res.json(await db.listBatches());
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

export default router;
