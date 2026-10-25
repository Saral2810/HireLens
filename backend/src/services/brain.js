import { callLLM } from './llmService.js';
import { parseNoticePeriodDays } from '../utils/validation.js';

/**
 * ─── Brain: the decisions inside a screening call ───────────────────────────
 * Runs on whatever model llmService points at (Evon or the backup LLM).
 * Phase B: decideTurn. Phases F/G add resume questions, summary and fit score.
 */

export const ANSWER_TYPES = ['yes_no', 'duration', 'ctc', 'text'];

// A question is asked at most twice: the original plus one repeat.
export const MAX_ATTEMPTS = 2;

const TURN_SYSTEM_PROMPT = `You are the decision step of an HR screening voice call in India.
You get the question the agent asked, the expected answer type, and the candidate's answer as transcribed by speech recognition. The answer may be in English, Hindi or Hinglish written in Latin script, and may contain recognition errors.

Decide:
- "next" if the answer addresses the question (even briefly, even with small recognition errors).
- "repeat" if the answer is empty, unclear, cut off, off-topic, or the candidate asks to hear the question again.

Extract the value when action is "next":
- duration (notice period): {"days": number}. "immediate"/"serving notice" = 0, months × 30, weeks × 7.
- ctc (salary per year): {"lpa": number} in lakh per annum. "nau lakh" = 9, "12,00,000" = 12, "1.2 crore" = 120, monthly amounts × 12 ÷ 100000.
- yes_no: {"yes": true|false}.
- text: {"text": "<short cleaned answer>"}.

When action is "repeat", write "say": one short, polite Hinglish sentence asking them to repeat, naming the topic (for example "Sorry, aapka notice period phir se bata dijiye?").

Reply with ONLY a JSON object: {"action":"next"|"repeat","extracted":object|null,"say":string|null}`;

/** Pulls the first JSON object out of a model reply (tolerates code fences or stray text). */
export function parseJsonReply(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

const VALUE_KEY = { duration: 'days', ctc: 'lpa', yes_no: 'yes', text: 'text' };

/**
 * Brings an extracted value to one shape per answer type ({days}, {lpa}, {yes}, {text}).
 * Models sometimes nest it one level deeper, e.g. {"yes_no": {"yes": true}}.
 */
export function normalizeExtracted(extracted, type) {
  const key = VALUE_KEY[type];
  if (!extracted || typeof extracted !== 'object') return null;
  const holder = key in extracted ? extracted : Object.values(extracted).find(v => v && typeof v === 'object' && key in v);
  if (!holder) return null;
  let value = holder[key];
  // Unwrap repeats of the same key, e.g. {"text": {"text": "Pune"}}.
  while (value && typeof value === 'object' && key in value) value = value[key];
  return { [key]: value };
}

function fallbackRepeatLine(question) {
  return `Sorry, main sun nahi paayi. ${question}`;
}

/**
 * Decides what happens after one answer.
 * @param {{ question: string, answerType?: string, transcript: string, attempt?: number }} turn
 *   attempt = how many times this question has been asked so far (1 = first time)
 * @param {{ llm?: typeof callLLM }} [deps]
 * @returns {Promise<{ action: 'next'|'repeat'|'skip', extracted: object|null, say: string|null, ms: number, source: 'llm'|'rule' }>}
 */
export async function decideTurn({ question, answerType = 'text', transcript, attempt = 1 }, { llm = callLLM } = {}) {
  const started = Date.now();
  const type = ANSWER_TYPES.includes(answerType) ? answerType : 'text';
  const heard = (transcript || '').trim();
  const finish = (decision, source) => {
    // Never ask more than MAX_ATTEMPTS times: a second unclear answer moves on.
    if (decision.action === 'repeat' && attempt >= MAX_ATTEMPTS) {
      decision = { action: 'skip', extracted: null, say: null };
    }
    return { ...decision, ms: Date.now() - started, source };
  };

  // Silence or a single filler word: no need to ask the model.
  if (heard.replace(/[^\p{L}\p{N}]/gu, '').length < 2) {
    return finish({ action: 'repeat', extracted: null, say: fallbackRepeatLine(question) }, 'rule');
  }

  const response = await llm({
    messages: [
      { role: 'system', content: TURN_SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ question, answer_type: type, transcript: heard }) }
    ],
    temperature: 0.2,
    max_tokens: 400
  });

  let parsed = null;
  if (response) {
    const data = await response.json().catch(() => null);
    parsed = parseJsonReply(data?.choices?.[0]?.message?.content);
  }

  if (!parsed || !['next', 'repeat'].includes(parsed.action)) {
    // Brain unavailable or unreadable reply: keep the call moving and store the raw answer.
    return finish({ action: 'next', extracted: { text: heard }, say: null }, 'rule');
  }

  let extracted = parsed.action === 'next' ? normalizeExtracted(parsed.extracted, type) : null;
  if (parsed.action === 'next' && type === 'duration' && typeof extracted?.days !== 'number') {
    const days = parseNoticePeriodDays(heard);
    if (days !== null) extracted = { days };
  }
  if (parsed.action === 'next' && !extracted) extracted = { text: heard };
  const say = parsed.action === 'repeat' ? (parsed.say || fallbackRepeatLine(question)) : null;
  return finish({ action: parsed.action, extracted, say }, 'llm');
}
