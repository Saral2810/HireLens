// Network guard + fake Gnani (Prisma STT, Timbre TTS) + fake LLM for the QA suite.
// No request ever leaves this machine: anything that is not localhost or one of the fakes is refused.

const REAL_FETCH = globalThis.fetch;
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
export const FAKE_LLM_HOST = 'fake-llm.qa.invalid';
const GNANI_HOST = 'api.vachana.ai';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// A request that never answers, except that (like real fetch) it fails once its AbortSignal fires.
const hangUntilAborted = (signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason)));

/** What the fakes have seen. Reset between tests with resetNetwork(). */
export const net = {
  prisma: 0, timbre: 0, llm: 0, refused: [],
  active: { prisma: 0, timbre: 0 },
  maxActive: { prisma: 0, timbre: 0 },
  llmKinds: { resume: 0, turn: 0, summary: 0, other: 0 },
  waits: { prisma: [], timbre: [] },
  // Form fields of every Prisma request and the text of every Timbre request, for assertions.
  prismaForms: [], timbreTexts: []
};

/** Per-service latency (ms) and optional failure injection. */
export const fakes = {
  latency: { prisma: 0, timbre: 0, llm: 0 },
  /** (service, n) → HTTP status to return instead of success, or null. n counts calls to that service from 1. */
  fail: null,
  /** (service) → true to make the request hang forever (no response at all). */
  hang: null,
  /** Optional override for the LLM's JSON reply: (kind, userPayload) → object | undefined. */
  llmReply: null
};

export function resetNetwork() {
  Object.assign(net, {
    prisma: 0, timbre: 0, llm: 0, refused: [],
    active: { prisma: 0, timbre: 0 }, maxActive: { prisma: 0, timbre: 0 },
    llmKinds: { resume: 0, turn: 0, summary: 0, other: 0 }, waits: { prisma: [], timbre: [] },
    prismaForms: [], timbreTexts: []
  });
  Object.assign(fakes, { latency: { prisma: 0, timbre: 0, llm: 0 }, fail: null, hang: null, llmReply: null });
}

/** Audio clip the fake Prisma "hears" as `text`. Empty text = silence. */
export function sayClip(text) {
  return Buffer.from(`RIFF-QA-SAY:${text}`);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function gnani(service, init) {
  net[service] += 1;
  const n = net[service];
  // Real Gnani allows ONE active request per API key; a second concurrent request is refused with 429.
  net.active[service] += 1;
  net.maxActive[service] = Math.max(net.maxActive[service], net.active[service]);
  const concurrent = net.active[service] > 1;
  try {
    if (fakes.hang?.(service, n)) await hangUntilAborted(init?.signal);
    if (fakes.latency[service]) await sleep(fakes.latency[service]);
    if (concurrent) return json({ success: false, message: 'RATE_LIMITED (QA fake: more than one active request)' }, 429);
    const injected = fakes.fail?.(service, n);
    if (injected) return json({ success: false, message: `QA injected ${injected}` }, injected);

    if (service === 'prisma') {
      const blob = init?.body?.get?.('audio_file');
      const field = (k) => init?.body?.get?.(k) ?? null;
      net.prismaForms.push({ model: field('model'), language_code: field('language_code'), format: field('format'), keyterms: field('keyterms'), topic: field('topic'), previous_text: field('previous_text') });
      const raw = blob ? Buffer.from(await blob.arrayBuffer()).toString('utf8') : '';
      const transcript = raw.startsWith('RIFF-QA-SAY:') ? raw.slice('RIFF-QA-SAY:'.length) : '';
      return json({ success: true, request_id: `qa_stt_${n}`, transcript, model: field('model') || 'prisma-v2.5' });
    }
    const text = JSON.parse(init?.body || '{}').text || '';
    net.timbreTexts.push(text);
    return new Response(Buffer.from(`QA-MP3:${text}`), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } });
  } finally {
    net.active[service] -= 1;
  }
}

// ── Fake LLM: answers the three prompts the app sends (resume questions, turn decision, summary) ──

function decideFake({ answer_type: type, transcript }) {
  const t = String(transcript || '').toLowerCase();
  if (/repeat|unclear|samajh nahi|kya\?/.test(t)) return { action: 'repeat', extracted: null, say: 'Sorry, phir se bataiye?' };
  if (type === 'yes_no') return { action: 'next', extracted: { yes: !/\b(nahi|no|not)\b/.test(t) }, say: null };
  if (type === 'duration') {
    const m = t.match(/(\d+(?:\.\d+)?)\s*(day|din|month|mahine|week)?/);
    if (/immediate/.test(t)) return { action: 'next', extracted: { days: 0 }, say: null };
    if (!m) return { action: 'repeat', extracted: null, say: 'Notice period phir se bataiye?' };
    const n = Number(m[1]);
    const days = /month|mahine/.test(m[2] || '') ? n * 30 : /week/.test(m[2] || '') ? n * 7 : n;
    return { action: 'next', extracted: { days }, say: null };
  }
  if (type === 'ctc') {
    const m = t.match(/(\d+(?:\.\d+)?)/);
    return m ? { action: 'next', extracted: { lpa: Number(m[1]) }, say: null } : { action: 'repeat', extracted: null, say: 'CTC phir se?' };
  }
  if (type === 'number') {
    const m = t.match(/(\d+(?:\.\d+)?)/);
    return { action: 'next', extracted: m ? { value: Number(m[1]) } : null, say: null };
  }
  return { action: 'next', extracted: { text: transcript }, say: null };
}

async function llm(init) {
  net.llm += 1;
  if (fakes.hang?.('llm', net.llm)) await hangUntilAborted(init?.signal);
  if (fakes.latency.llm) await sleep(fakes.latency.llm);
  const injected = fakes.fail?.('llm', net.llm);
  if (injected) return json({ error: `QA injected ${injected}` }, injected);

  const body = JSON.parse(init?.body || '{}');
  const system = body.messages?.[0]?.content || '';
  const user = JSON.parse(body.messages?.[1]?.content || '{}');
  const kind = /resume part/.test(system) ? 'resume' : /decision step/.test(system) ? 'turn' : /finished HR screening/.test(system) ? 'summary' : 'other';
  net.llmKinds[kind] += 1;

  let reply = fakes.llmReply?.(kind, user);
  if (reply === undefined) {
    if (kind === 'resume') {
      reply = { questions: [
        // Real resume questions differ per candidate, so each one needs its own Timbre voice line.
        `Aapne ${user.job_role || 'is role'} mein sabse bada project kaunsa kiya? (resume ${net.llm})`,
        `Us project mein aapka exact role kya tha, thoda detail mein bataiye? (resume ${net.llm})`,
        `Kaunsi technology aapko sabse zyada pasand hai aur kyun? (resume ${net.llm})`,
        `Kisi production issue ke baare mein bataiye jo aapne fix kiya? (resume ${net.llm})`
      ] };
    } else if (kind === 'turn') reply = decideFake(user);
    else if (kind === 'summary') reply = { summary: `QA fake summary for ${user.job_role}: ${user.answers?.length || 0} answers reviewed.`, fit_score: 72 };
    else reply = {};
  }
  return json({ choices: [{ message: { content: JSON.stringify(reply) } }] });
}

export function installNetworkGuard() {
  const llmUrl = new URL(process.env.LLM_API_URL || 'http://unset.invalid');
  if (llmUrl.hostname !== FAKE_LLM_HOST) {
    throw new Error(`QA setup refused: LLM_API_URL must point at ${FAKE_LLM_HOST}, got ${llmUrl.hostname}. No real LLM may be used.`);
  }
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    if (LOCAL_HOSTS.has(url.hostname)) return REAL_FETCH(input, init);
    if (url.hostname === GNANI_HOST) return gnani(url.pathname.startsWith('/stt') ? 'prisma' : 'timbre', init);
    if (url.hostname === FAKE_LLM_HOST) return llm(init);
    net.refused.push(url.host);
    throw new Error(`QA network guard refused a request to ${url.host} (only localhost and in-process fakes are allowed).`);
  };
}
