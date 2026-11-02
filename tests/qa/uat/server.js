// UAT server: the real app (built client + API) on http://localhost:4310 with the in-memory fake
// database, fake Gnani and fake LLM, seeded with made-up campaigns and finished calls, so every
// screen can be checked in a browser without credits or real data.
// Run: npm run build (once), then node --import ./tests/qa/setup.js tests/qa/uat/server.js
// Sign in as Admin by setting localStorage.hr_auth_token = 'test:superadmin:admin-1:admin@qa.test'.
import { installFakeDb } from '../helpers/fakeDb.js';
import { fakes } from '../helpers/network.js';
import { makeClient, tokens, liveCampaign, takeCall, HAPPY_ANSWERS } from '../helpers/http.js';
import app from '../../../backend/src/app.js';

const PORT = Number(process.env.UAT_PORT || 4310);
const store = installFakeDb();
store.addProfile({ id: 'admin-1', email: 'admin@qa.test', name: 'UAT Admin', role: 'superadmin' });

const server = app.listen(PORT, '127.0.0.1', async () => {
  const c = makeClient(`http://127.0.0.1:${PORT}`);
  const admin = tokens.admin();
  // Varied rubric ratings so the results table is not all the same.
  let n = 0;
  fakes.llmReply = (kind, user) => {
    if (kind !== 'summary') return undefined;
    n += 1;
    const v = [8, 6, 9, 4][n % 4];
    const reasons = { role_skills: 'Talked about Node.js, Kafka and PostgreSQL in production.', project_depth: 'Explained the reconciliation design and their own part in it.',
      problem_solving: 'Found consumer lag and fixed it with partitions and batching.', communication: 'Answers were specific and on topic.' };
    return { summary: `Made-up candidate ${n}: backend experience shown in ${user.answers.length} answers; notice period and CTC given.`,
      scores: Object.fromEntries(Object.entries(reasons).map(([k, r], i) => [k, { score: Math.max(0, Math.min(10, v + (i % 2 ? -1 : 1))), reason: r }])) };
  };
  const people = [['Asha Rao', 'asha'], ['Rohan Mehta', 'rohan'], ['Priya Nair', 'priya'], ['Imran Shaikh', 'imran']];
  await liveCampaign(c, admin, { name: 'Backend Engineers – November', company_intro: 'Kirana Pay builds billing software for small shops (made-up).',
    people: people.map(([name, id]) => ({ name, email: `${id}@uat.test` })) });
  for (const [, id] of people.slice(0, 3)) {
    const cand = store.candidates.find(x => x.email === `${id}@uat.test`);
    await takeCall(c, tokens.candidate(cand.id, cand.email), HAPPY_ANSWERS);
  }
  // A draft and a completed (closed) campaign for the tabs.
  await c.post('/api/hr/batches', { token: admin, json: { name: 'Data Analysts – draft', job_role: 'Data Analyst', company_name: 'Demo Co' } });
  const done = (await c.post('/api/hr/batches', { token: admin, json: { name: 'QA Interns – October', job_role: 'QA Intern', company_name: 'Demo Co' } })).body;
  await c.post(`/api/hr/batches/${done.id}/candidates`, { token: admin, json: { candidates: [{ name: 'Kavya Iyer', email: 'kavya@uat.test' }] } });
  await c.post(`/api/hr/batches/${done.id}/run`, { token: admin });
  await c.post(`/api/hr/batches/${done.id}/close`, { token: admin });
  await new Promise(r => setTimeout(r, 300));
  console.log(`UAT server ready on http://localhost:${PORT} — ${store.calls.length} calls, campaign ${store.batches[0].id}`);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
