// Child process for the load simulation: the real app with the fake DB and fake Gnani/LLM, timed to
// realistic latencies divided by QA_SCALE. Runs separately from the load driver so its memory can be
// measured on its own. Reports readiness, memory samples and counters over IPC. No real network.
import { installFakeDb } from '../helpers/fakeDb.js';
import { net, fakes } from '../helpers/network.js';
import { speechRetry } from '../../../backend/src/services/gnaniSpeech.js';

const SCALE = Number(process.env.QA_SCALE || 10);
// Time runs SCALE times faster here: per-minute rate limits would be SCALE times stricter, so they are
// off (they are covered by tests/qa/integration/hardening.int.test.js), and an idle call frees its line
// after 3 "real" minutes, i.e. 180 s / SCALE.
process.env.QA_RATE_LIMITS = 'off';
process.env.CALL_SLOT_IDLE_MS = String(180000 / SCALE);
// Real-world latencies (ms) observed or typical: Prisma ~0.9 s per answer, Timbre ~0.7 s per line,
// LLM (Groq gpt-oss-120b) ~1.2 s, Supabase round trip ~40 ms. Each is divided by SCALE.
fakes.latency = { prisma: 900 / SCALE, timbre: 700 / SCALE, llm: 1200 / SCALE };
speechRetry.delaysMs = [600 / SCALE, 1500 / SCALE];

// ~2% of Prisma requests get the transient 403 seen in the real browser test.
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
fakes.fail = (svc) => (svc === 'prisma' && rand() < 0.02 ? 403 : null);

const store = installFakeDb({ latencyMs: 40 / SCALE });

// Email scenario: a Gmail-like mailbox (~1.2 s per message) that refuses ~3% of messages with a
// temporary "try again later", as Gmail does when many go out at once.
let mail = null;
if (process.env.QA_MAIL === '1') {
  const { installFakeMail } = await import('../helpers/mail.js');
  mail = installFakeMail({
    latencyMs: 1200 / SCALE,
    fail: () => (rand() < 0.03 ? Object.assign(new Error('421 4.7.0 Try again later, closing connection.'), { responseCode: 421 }) : null)
  });
}
const { default: app } = await import('../../../backend/src/app.js');

// Silence the per-request console logging so it does not dominate CPU in the child.
console.log = () => {};
console.warn = () => {};

const server = app.listen(0, '127.0.0.1', () => process.send({ type: 'ready', port: server.address().port }));
server.requestTimeout = 0;
server.headersTimeout = 0;

let peak = 0;
setInterval(() => {
  const rss = process.memoryUsage().rss;
  peak = Math.max(peak, rss);
}, 20).unref();

process.on('message', (m) => {
  if (m === 'stats') {
    process.send({
      type: 'stats',
      net: { prisma: net.prisma, timbre: net.timbre, llm: net.llm, llmKinds: net.llmKinds, maxActive: net.maxActive, refused: net.refused },
      db: {
        candidates: store.candidates.length,
        byStatus: store.candidates.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] || 0) + 1 }), {}),
        calls: store.calls.length,
        callsByStatus: store.calls.reduce((a, c) => ({ ...a, [c.status]: (a[c.status] || 0) + 1 }), {}),
        withSummary: store.calls.filter(c => c.summary).length,
        answers: store.answers.length,
        files: store.files.size,
        callGaps: store.calls.map(k => {
          // Transcript times are real clock times (the fake DB's started_at uses its own clock).
          const times = (k.transcript || []).map(e => Date.parse(e.at)).filter(Number.isFinite).sort((a, b) => a - b);
          let gap = 0;
          for (let i = 1; i < times.length; i += 1) gap = Math.max(gap, times[i] - times[i - 1]);
          return { id: k.id, status: k.status, maxGapMs: gap, lines: (k.transcript || []).length };
        })
      },
      memory: { peakRss: peak, rss: process.memoryUsage().rss },
      mail: mail && {
        attempts: mail.attempts, sent: mail.sent.length, maxParallel: mail.maxActive,
        links: mail.sent.map(m => ({ to: m.to, link: m.link })),
        rows: store.candidates.map(c => ({ email: c.email, sent_at: c.invite_email_sent_at, error: c.invite_email_error, user_id: c.user_id, id: c.id }))
      }
    });
  }
  if (m === 'reset-peak') peak = process.memoryUsage().rss;
  if (m === 'exit') process.exit(0);
});
