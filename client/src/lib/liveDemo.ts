// Live demo of a HireX campaign, for the public /live page (and for embedding on a website).
// Everything here is made up and runs in the browser: no API calls, no real candidates. A fixed
// script of timed events (campaign set up → candidates added → invites → resumes → voice calls →
// scores) is replayed; stateAt(script, t) gives the dashboard's state at any second, so the page
// can pause, change speed or restart without keeping its own history.

export type DemoStage = 'added' | 'invited' | 'resume' | 'ready' | 'on_call' | 'dropped' | 'completed';
export type DemoLanguage = 'English + Hindi' | 'English' | 'Hindi';

export interface DemoCandidate {
  id: string;
  name: string;
  city: string;
  stage: DemoStage;
  language: DemoLanguage;
  ats: number | null;
  fit: number | null;
  fresher: boolean;
  question: number;
  summary: string | null;
}

export interface DemoLine { who: 'agent' | 'candidate'; text: string }

export interface DemoEvent {
  t: number;
  kind: 'campaign' | 'questions' | 'added' | 'live' | 'invited' | 'resume' | 'ready' | 'call_start' | 'line' | 'progress' | 'dropped' | 'retry' | 'completed' | 'reminder';
  id?: string;
  text: string;
  line?: DemoLine;
  ats?: number;
  fit?: number;
  summary?: string;
  question?: number;
}

export interface DemoState {
  t: number;
  phase: 'setup' | 'running' | 'done';
  campaign: { name: string; role: string; company: string; live: boolean; questions: number };
  candidates: DemoCandidate[];
  feed: { t: number; text: string }[];
  spotlight: { id: string; name: string; lines: DemoLine[]; question: number; total: number; done: boolean } | null;
  stats: { total: number; emailed: number; resumes: number; onCall: number; completed: number; avgFit: number | null; avgAts: number | null };
}

export const DEMO_CAMPAIGN = { name: 'Backend Engineers – November', role: 'Backend Engineer', company: 'Kirana Pay (demo company)' };
export const CALL_QUESTIONS = 12;

interface Persona {
  id: string; name: string; city: string; language: DemoLanguage; ats: number; fit: number | null; fresher?: boolean;
  summary: string; drops?: boolean; noShow?: boolean; lines?: [DemoLine['who'], string][];
}

// Made-up people. The three with lines are the calls shown word for word.
const PEOPLE: Persona[] = [
  { id: 'c1', name: 'Asha Rao', city: 'Pune', language: 'English + Hindi', ats: 84, fit: 82,
    summary: '4 years on Node.js payment services; led a Kafka migration and cut settlement delays. 60-day notice, expects 18 LPA.',
    lines: [
      ['agent', 'Namaste Asha! Main Kirana Pay ki taraf se HireX ki voice assistant bol rahi hoon. Kya aap ready hain?'],
      ['candidate', 'Haan, ready hoon.'],
      ['agent', 'Kirana Pay chhote dukaanon ke liye billing aur UPI software banata hai. Apne kisi project ke baare mein bataiye jis par aapko garv hai?'],
      ['candidate', 'Maine payments reconciliation service banayi thi Node.js mein, roz do lakh orders handle karti hai.'],
      ['agent', 'Achha, usme aapka exact role kya tha aur design kaise decide kiya?'],
      ['candidate', 'Main tech lead thi. Humne Kafka se events liye aur PostgreSQL mein idempotent writes kiye.'],
      ['agent', 'Us project mein sabse badi problem kya aayi?'],
      ['candidate', 'Consumer lag badh raha tha. Maine partitions badhaye aur batching ki, lag 40% kam hua.'],
      ['agent', 'Aapka current notice period kitna hai?'],
      ['candidate', 'Do mahine.'],
      ['agent', 'Aapki expected CTC kitni hai?'],
      ['candidate', 'Atharah lakh.'],
      ['agent', 'Dhanyavaad Asha! HR team jaldi aapse contact karegi.']
    ] },
  { id: 'c2', name: 'Rohan Mehta', city: 'Bengaluru', language: 'English', ats: 71, fit: 68,
    summary: '3 years building REST APIs in Python; solid on testing, less depth on queues. Immediate joiner, expects 14 LPA.' },
  { id: 'c3', name: 'Priya Nair', city: 'Kochi', language: 'English', ats: 62, fit: 74, fresher: true,
    summary: 'Fresher: final-year project on a real-time chat app with WebSockets, explained reconnect handling well. Expects 6 LPA.',
    lines: [
      ['agent', 'Hello Priya! I am the HireX voice assistant for Kirana Pay. Are you ready to talk?'],
      ['candidate', 'Yes, I am ready.'],
      ['agent', 'Tell me about one project you are most proud of.'],
      ['candidate', 'I built a chat app with WebSockets in my final year. I am a fresher, this would be my first job.'],
      ['agent', 'How did you handle users losing their connection?'],
      ['candidate', 'The client retries with backoff and the server replays missed messages from Redis.'],
      ['agent', 'What is your expected CTC?'],
      ['candidate', 'Around six lakh.'],
      ['agent', 'Thank you Priya! The HR team will contact you soon.']
    ] },
  { id: 'c4', name: 'Imran Shaikh', city: 'Mumbai', language: 'Hindi', ats: 77, fit: 79,
    summary: '5 years on Java and Spring; strong on database tuning. Answered in Hindi. 30-day notice, expects 20 LPA.',
    lines: [
      ['agent', 'नमस्ते इमरान! क्या आप अभी बात करने के लिए तैयार हैं?'],
      ['candidate', 'हाँ, तैयार हूँ।'],
      ['agent', 'अपने किसी एक project के बारे में बताइए जिस पर आपको सबसे ज़्यादा गर्व है।'],
      ['candidate', 'मैंने order service की database queries tune कीं, response time 2 second से 300 ms हुआ।'],
      ['agent', 'आपका notice period कितना है?'],
      ['candidate', 'तीस दिन।'],
      ['agent', 'धन्यवाद! HR टीम जल्दी आपसे संपर्क करेगी।']
    ] },
  { id: 'c5', name: 'Sneha Kulkarni', city: 'Nagpur', language: 'English + Hindi', ats: 58, fit: 61, drops: true,
    summary: '2 years on a PHP to Node.js migration; the call dropped once and she finished it on a retry. 45-day notice.' },
  { id: 'c6', name: 'Arjun Verma', city: 'Delhi', language: 'English', ats: 88, fit: 87,
    summary: '6 years on distributed systems in Go and Node.js; designed an idempotent payments ledger. 90-day notice, expects 28 LPA.' },
  { id: 'c7', name: 'Kavya Iyer', city: 'Chennai', language: 'English + Hindi', ats: 66, fit: null, noShow: true,
    summary: 'Has not opened the invite yet: a reminder was sent.' },
  { id: 'c8', name: 'Deepak Singh', city: 'Lucknow', language: 'Hindi', ats: 49, fit: 52,
    summary: '1 year on support scripts; answers stayed general when asked for specifics. Immediate joiner.' }
];

/** The fixed script, in time order (seconds from the start at 1× speed). */
export function buildDemoScript(): DemoEvent[] {
  const ev: DemoEvent[] = [];
  const add = (e: DemoEvent) => ev.push(e);
  add({ t: 0, kind: 'campaign', text: `HR created the campaign “${DEMO_CAMPAIGN.name}” for ${DEMO_CAMPAIGN.role}` });
  add({ t: 1.2, kind: 'questions', text: 'Company intro and 5 HR questions added: notice period, CTC, city, joining date' });
  PEOPLE.forEach((p, i) => add({ t: 2.4 + i * 0.35, id: p.id, kind: 'added', text: `${p.name} added from the Excel sheet` }));
  add({ t: 5.6, kind: 'live', text: 'Campaign is live: invite emails are going out' });
  PEOPLE.forEach((p, i) => add({ t: 6 + i * 0.4, id: p.id, kind: 'invited', text: `Invite emailed to ${p.name}` }));

  PEOPLE.forEach((p, i) => {
    if (p.noShow) {
      add({ t: 62, id: p.id, kind: 'reminder', text: `${p.name} has not opened the invite: reminder sent` });
      return;
    }
    const start = 10 + i * 5.2;
    add({ t: start, id: p.id, kind: 'resume', ats: p.ats, text: `${p.name} uploaded a resume · ATS score ${p.ats}` });
    add({ t: start + 1.3, id: p.id, kind: 'ready', text: `${p.name} passed the mic check and agreed to recording` });
    const callStart = start + 2.4;
    add({ t: callStart, id: p.id, kind: 'call_start', text: `${p.name} started a voice call in ${p.language}` });
    const lines = p.lines || [];
    const steps = Math.max(lines.length, CALL_QUESTIONS);
    const dropAt = p.drops ? 5 : -1;
    let t = callStart;
    for (let q = 1; q <= steps; q += 1) {
      t += 1.1;
      if (q === dropAt) {
        add({ t, id: p.id, kind: 'dropped', question: q, text: `${p.name}'s call dropped at question ${q} (network)` });
        t += 3;
        add({ t, id: p.id, kind: 'retry', text: `${p.name} retried the call from the start` });
        t += 1.1;
      }
      const line = lines[q - 1];
      if (line) add({ t, id: p.id, kind: 'line', question: Math.min(q, CALL_QUESTIONS), line: { who: line[0], text: line[1] }, text: '' });
      else add({ t, id: p.id, kind: 'progress', question: Math.min(Math.round((q / steps) * CALL_QUESTIONS), CALL_QUESTIONS), text: '' });
    }
    add({ t: t + 1.2, id: p.id, kind: 'completed', fit: p.fit ?? undefined, summary: p.summary,
      text: `${p.name} finished the call · fit score ${p.fit}${p.fresher ? ' · fresher, so notice period and current CTC were not asked' : ''}` });
  });
  return ev.sort((a, b) => a.t - b.t);
}

/** When the script ends (the last event), in seconds at 1×. */
export function scriptLength(script: DemoEvent[]): number {
  return script.length ? script[script.length - 1].t : 0;
}

const average = (values: number[]) => (values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : null);

/** The dashboard's state after every event up to second `t`. */
export function stateAt(script: DemoEvent[], t: number): DemoState {
  const people = new Map<string, DemoCandidate>();
  const feed: DemoState['feed'] = [];
  const lines = new Map<string, DemoLine[]>();
  let live = false;
  let questions = 0;
  let spotlightId: string | null = null;

  for (const e of script) {
    if (e.t > t) break;
    if (e.text) feed.push({ t: e.t, text: e.text });
    const p = e.id ? PEOPLE.find(x => x.id === e.id)! : null;
    const c = e.id ? people.get(e.id) : undefined;
    switch (e.kind) {
      case 'questions': questions = 5; break;
      case 'live': live = true; break;
      case 'added':
        people.set(p!.id, { id: p!.id, name: p!.name, city: p!.city, stage: 'added', language: p!.language, ats: null, fit: null, fresher: !!p!.fresher, question: 0, summary: null });
        break;
      case 'invited': if (c) c.stage = 'invited'; break;
      case 'reminder': if (c) c.summary = p!.summary; break;
      case 'resume': if (c) { c.stage = 'resume'; c.ats = e.ats ?? null; } break;
      case 'ready': if (c) c.stage = 'ready'; break;
      case 'call_start': case 'retry':
        if (c) { c.stage = 'on_call'; c.question = 0; lines.set(c.id, []); }
        if (p?.lines) spotlightId = p.id;
        break;
      case 'line':
        if (c) { c.question = e.question ?? c.question; lines.get(c.id)?.push(e.line!); }
        break;
      case 'progress': if (c) c.question = e.question ?? c.question; break;
      case 'dropped': if (c) c.stage = 'dropped'; break;
      case 'completed':
        if (c) { c.stage = 'completed'; c.fit = e.fit ?? null; c.summary = e.summary ?? null; c.question = CALL_QUESTIONS; }
        break;
      default: break;
    }
  }

  const candidates = [...people.values()];
  const sp = spotlightId ? people.get(spotlightId) : null;
  const done = candidates.length > 0 && t >= scriptLength(script);
  return {
    t,
    phase: !live ? 'setup' : done ? 'done' : 'running',
    campaign: { ...DEMO_CAMPAIGN, live, questions },
    candidates,
    feed: feed.slice(-40).reverse(),
    spotlight: sp ? { id: sp.id, name: sp.name, lines: lines.get(sp.id) || [], question: sp.question, total: CALL_QUESTIONS, done: sp.stage === 'completed' } : null,
    stats: {
      total: candidates.length,
      emailed: candidates.filter(c => c.stage !== 'added').length,
      resumes: candidates.filter(c => c.ats !== null).length,
      onCall: candidates.filter(c => c.stage === 'on_call').length,
      completed: candidates.filter(c => c.stage === 'completed').length,
      avgFit: average(candidates.filter(c => c.fit !== null).map(c => c.fit!)),
      avgAts: average(candidates.filter(c => c.ats !== null).map(c => c.ats!))
    }
  };
}
