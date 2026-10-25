import { Router } from 'express';
import multer from 'multer';
import db from '../config/db.js';
import { extractResumeText, MAX_RESUME_BYTES } from '../services/resumeParser.js';
import { writeResumeQuestions } from '../services/brain.js';
import { expireStaleCall } from './call.js';
import { retriesLeft } from '../services/callFlow.js';

/**
 * Candidate API. Mounted at /api/candidate behind requireAuth + requireRole('candidate').
 * A candidate only ever works on their own candidate record.
 */
const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_RESUME_BYTES, files: 1 } });

// Resume and consent can change only before the call starts.
const EDITABLE_STATUSES = ['invited', 'resume_uploaded'];

async function loadOwnCandidate(req, res) {
  let candidate = await db.getCandidateForUser(req.user.id);
  // First visit after Google / email-code sign-in: link the rows HR added for this email.
  if (!candidate && await db.claimCandidatesByEmail(req.user.id, req.user.email)) candidate = await db.getCandidateForUser(req.user.id);
  if (!candidate) {
    res.status(404).json({ error: 'Not Found', message: 'No screening found for this email. Check with HR that they added this exact address and ran the campaign.' });
    return null;
  }
  return candidate;
}

function publicView(candidate, retries = 0) {
  return {
    id: candidate.id,
    name: candidate.name,
    status: candidate.status,
    failure_reason: candidate.status === 'failed' ? candidate.failure_reason || null : null,
    retries_left: candidate.status === 'failed' ? retries : 0,
    consent_given: !!candidate.consent_at,
    has_resume: !!candidate.resume_path,
    batch: candidate.batch && {
      id: candidate.batch.id, name: candidate.batch.name, batch_date: candidate.batch.batch_date,
      job_role: candidate.batch.job_role, company_name: candidate.batch.company_name, status: candidate.batch.status
    }
  };
}

/** GET /api/candidate/screenings → every screening of this candidate (dashboard history). */
router.get('/screenings', async (req, res, next) => {
  try {
    await db.claimCandidatesByEmail(req.user.id, req.user.email);
    res.json(await db.listScreeningsForUser(req.user.id));
  } catch (err) { next(err); }
});

/** GET /api/candidate/me → own record, batch and progress (questions stay hidden until the call). */
router.get('/me', async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    await expireStaleCall(candidate);
    const retries = candidate.status === 'failed' ? retriesLeft(await db.listCallsForCandidates([candidate.id])) : 0;
    res.json(publicView(candidate, retries));
  } catch (err) { next(err); }
});

/**
 * POST /api/candidate/resume (multipart, field "resume")
 * Reads the PDF, stores it privately at resumes/<batch-id>/<candidate-id>.pdf, writes the
 * resume questions for the call and marks the candidate "resume_uploaded". Can be repeated
 * (replaces the resume) until the call starts.
 */
router.post('/resume', upload.single('resume'), async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    if (!EDITABLE_STATUSES.includes(candidate.status)) {
      return res.status(409).json({ error: 'Conflict', message: 'Your screening call has already started, so the resume can no longer be changed.' });
    }
    if (candidate.batch?.status !== 'live') {
      return res.status(409).json({ error: 'Conflict', message: 'This campaign is closed. Please contact the HR team.' });
    }
    if (!req.file?.buffer?.length) {
      return res.status(400).json({ error: 'Bad Request', message: 'Choose a PDF resume to upload.' });
    }

    const resume = await extractResumeText(req.file.buffer);
    const path = `${candidate.batch_id}/${candidate.id}.pdf`;
    await db.uploadFile('resumes', path, req.file.buffer, 'application/pdf');

    const { questions, source } = await writeResumeQuestions({
      resumeText: resume.readable ? resume.text : '',
      jobRole: candidate.batch?.job_role,
      jobDescription: candidate.batch?.job_description
    });

    const updated = await db.updateCandidate(candidate.id, {
      resume_path: path,
      resume_text: resume.readable ? resume.text : null,
      resume_questions: questions,
      status: 'resume_uploaded'
    });

    res.json({
      status: updated.status,
      readable: resume.readable,
      pages: resume.pages,
      questions_ready: questions.length,
      questions_from: source === 'llm' ? 'resume' : 'general',
      message: resume.readable
        ? 'Resume received. Your screening questions are ready.'
        : 'We could not read text from this PDF (it may be a scan), so the call will use general questions about the role. You can upload a text-based PDF instead.'
    });
  } catch (err) { next(err); }
});

/** POST /api/candidate/consent → records that the candidate agreed to recording and transcription. */
router.post('/consent', async (req, res, next) => {
  try {
    const candidate = await loadOwnCandidate(req, res);
    if (!candidate) return;
    if (req.body?.agree !== true) {
      return res.status(400).json({ error: 'Bad Request', message: 'Consent must be given explicitly.' });
    }
    if (!EDITABLE_STATUSES.includes(candidate.status)) {
      return res.status(409).json({ error: 'Conflict', message: 'Your screening call has already started.' });
    }
    const updated = candidate.consent_at ? candidate : await db.updateCandidate(candidate.id, { consent_at: new Date().toISOString() });
    res.json({ consent_given: true, consent_at: updated.consent_at });
  } catch (err) { next(err); }
});

// Upload errors from multer happen before the route runs; turn them into clear 400s.
router.use((err, req, res, next) => {
  if (err?.name === 'MulterError') {
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'The resume is larger than 5 MB.' : 'Upload one PDF file in the "resume" field.';
    return res.status(400).json({ error: 'Bad Request', message });
  }
  next(err);
});

export default router;
