// Starts the real Express app on a free localhost port and gives tests a small client for it.
import app from '../../../backend/src/app.js';
import { makeTextPdf } from '../../../backend/scripts/makeTextPdf.js';
import { sayClip } from './network.js';

export async function startApp() {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise(r => server.close(r)), client: makeClient(base) };
}

/** Test tokens are only honoured when NODE_ENV=test (see middleware/auth.js). */
export const tokens = {
  admin: (id = 'admin-1', email = 'admin@qa.test') => `test:superadmin:${id}:${email}`,
  recruiter: (id, email = `${id}@qa.test`) => `test:recruiter:${id}:${email}`,
  candidate: (id, email) => `test:candidate:${id}:${email}`
};

export function makeClient(base) {
  async function call(method, path, { token, json, form, headers = {} } = {}) {
    const init = { method, headers: { ...headers } };
    if (token) init.headers.Authorization = `Bearer ${token}`;
    if (json !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(json); }
    if (form) init.body = form;
    const res = await fetch(base + path, init);
    const type = res.headers.get('content-type') || '';
    const body = type.includes('json') ? await res.json().catch(() => null) : type.startsWith('text/') ? await res.text() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, body, headers: res.headers };
  }
  return {
    call,
    get: (path, opts) => call('GET', path, opts),
    post: (path, opts) => call('POST', path, opts),
    patch: (path, opts) => call('PATCH', path, opts),
    put: (path, opts) => call('PUT', path, opts),
    del: (path, opts) => call('DELETE', path, opts)
  };
}

export const RESUME_PDF = makeTextPdf([
  'Asha Rao - Backend Engineer (made-up resume for QA)',
  'Experience: 4 years at Demo Fintech building Node.js and PostgreSQL services',
  'Built a payments reconciliation service processing two million transactions a day',
  'Led the migration from a monolith to microservices on AWS ECS with zero downtime',
  'Skills: Node.js, TypeScript, PostgreSQL, Kafka, Docker, AWS, Redis caching, observability'
]);

/** Starts like a real WebM file (EBML header 1A 45 DF A3), as the browser's MediaRecorder output does. */
export const WEBM_SAMPLE = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from('qa-webm-recording')]);

export function fileForm(field, buffer, filename, type, extra = {}) {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), filename);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

/** One spoken answer (or silence when text is empty). */
export function answerForm(text) {
  return text ? fileForm('audio', sayClip(text), 'answer.wav', 'audio/wav') : (() => { const f = new FormData(); f.append('no_speech', '1'); return f; })();
}

/**
 * HR side: creates a live campaign with the default HR questions and the given candidates.
 * @returns {Promise<{ batch: object, candidates: object[] }>}
 */
export async function liveCampaign(client, token, { name = 'QA Campaign', job_role = 'Backend Engineer', people = [], ...extra } = {}) {
  // extra: more campaign fields, e.g. company_intro or call_languages
  const batch = (await client.post('/api/hr/batches', { token, json: { name, job_role, company_name: 'QA Demo Co', ...extra } })).body;
  await client.post(`/api/hr/batches/${batch.id}/questions/defaults`, { token });
  const added = await client.post(`/api/hr/batches/${batch.id}/candidates`, { token, json: { candidates: people } });
  if (people.length) await client.post(`/api/hr/batches/${batch.id}/run`, { token });
  return { batch, candidates: added.body?.candidates || [] };
}

/**
 * Answers that complete the default script: intro yes, proud project, biggest problem, 3 resume answers,
 * the full-time experience check, notice, current CTC, expected CTC, city, joining (12 in all).
 */
export const HAPPY_ANSWERS = [
  'haan ready hoon',
  'Maine payments reconciliation service banayi thi Node.js mein, main tech lead tha',
  'Sabse badi problem Kafka consumer lag thi, maine partitions badhaye aur batching ki',
  'Main tech lead tha aur design maine kiya',
  'PostgreSQL pasand hai kyunki reliable hai',
  'Ek baar Kafka consumer lag fix kiya tha',
  'Haan, teen saal se full-time job kar raha hoon',
  '60 days',
  '9 lakh',
  '12 lakh',
  'Pune, relocate kar sakta hoon',
  'Do mahine mein join kar sakta hoon'
];

/** Candidate side: resume → consent → start → every answer. Returns the last /turn response. */
export async function takeCall(client, token, answers = HAPPY_ANSWERS) {
  const resume = await client.post('/api/candidate/resume', { token, form: fileForm('resume', RESUME_PDF, 'resume.pdf', 'application/pdf') });
  if (resume.status !== 200) return { step: 'resume', ...resume };
  const consent = await client.post('/api/candidate/consent', { token, json: { agree: true } });
  if (consent.status !== 200) return { step: 'consent', ...consent };
  const start = await client.post('/api/candidate/call/start', { token });
  if (start.status !== 200) return { step: 'start', ...start };
  let last = start;
  for (const a of answers) {
    last = await client.post('/api/candidate/call/turn', { token, form: answerForm(a) });
    if (last.status !== 200 || last.body.done) break;
  }
  return { step: 'turns', ...last, start };
}
