import dotenv from 'dotenv';
import { logExternalCall, generateRequestId } from './observability/externalCallLogger.js';

dotenv.config();

/**
 * ─── Gnani Speech APIs ──────────────────────────────────────────────────────
 * Prisma v3.0 (speech → text, REST, clips up to 30 s; longer answers are sent in parts) and Timbre
 * (text → speech, REST). Docs: docs.gnani.ai/api/STT/speech-to-text and docs.gnani.ai/api/TTS/tts-inference
 *
 *   GNANI_SPEECH_API_KEY  sent as the X-API-Key-ID header
 *   GNANI_STT_MODEL       prisma-v3.0 (default) | prisma-v2.5
 *   GNANI_STT_LANGUAGE    en-IN (accepts Hindi–English mixed speech, returns Latin script); on v3.0 also a
 *                         list of hints such as en-IN,hi-IN
 *   GNANI_TTS_MODEL       timbre-v2.5 | timbre-v3.0
 *   GNANI_TTS_VOICE       e.g. Poorvi (the Hinglish voice for timbre-v2.5)
 *   GNANI_TTS_LANGUAGE    hi-en | en-IN | hi-IN | auto ...
 *   GNANI_TIMEOUT_MS      give up on one request after this long (default 15000)
 */

export const STT_URL = 'https://api.vachana.ai/stt/v3';
export const TTS_URL = 'https://api.vachana.ai/api/v1/tts/inference';

// Prisma accepts these containers; Chrome's default WebM is not among them.
const STT_CONTENT_TYPES = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4' };
const TTS_CONTENT_TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };

export class SpeechError extends Error {
  /** @param {boolean} [retryable] true for a refusal that may pass on a second try (403/429/5xx, network) */
  constructor(message, status, retryable = false) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
    this.retryable = retryable;
  }
}

// Gnani sometimes refuses a request for a moment (seen: 403 with no reason, ~0.1 s, then fine again).
// Such requests are tried again after these pauses. Tests shorten them.
export const speechRetry = { delaysMs: [600, 1500] };
const isRetryableStatus = (status) => status === 403 || status === 408 || status === 429 || status >= 500;

async function withRetry(task) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (err) {
      if (!err?.retryable || attempt >= speechRetry.delaysMs.length) throw err;
      await new Promise(r => setTimeout(r, speechRetry.delaysMs[attempt]));
    }
  }
}

// Gnani allows one active request per API key at a time (Timbre answers 429 RATE_LIMITED otherwise),
// so each service runs its requests one after another, shared by every call on this server.
function serialQueue() {
  let tail = Promise.resolve();
  return (task) => {
    const run = tail.then(task, task);
    tail = run.catch(() => {});
    return run;
  };
}
const prismaQueue = serialQueue();

// Every request has a deadline: the queues above are shared by all calls, so one request that never
// answers would otherwise stop every candidate's call until the server restarts.
export function gnaniTimeoutMs() {
  const ms = Number(process.env.GNANI_TIMEOUT_MS || 15000);
  return Number.isFinite(ms) && ms > 0 ? ms : 15000;
}

/** Network failure → SpeechError (retryable), with a plain message for timeouts. */
function networkError(service, err) {
  const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
  return new SpeechError(timedOut ? `${service} did not answer within ${gnaniTimeoutMs() / 1000} s.` : `${service} request failed: ${err.message}`, timedOut ? 504 : 502, true);
}
const timbreQueue = serialQueue();

function apiKey() {
  const key = (process.env.GNANI_SPEECH_API_KEY || '').trim();
  if (!key) throw new SpeechError('GNANI_SPEECH_API_KEY is not set in .env.', 503);
  return key;
}

export function isSpeechConfigured() {
  return Boolean((process.env.GNANI_SPEECH_API_KEY || '').trim() && (process.env.GNANI_TTS_VOICE || '').trim());
}

export const PRISMA_V3 = 'prisma-v3.0';

/** The Prisma model in use; v2.5 is Gnani's default when no model is sent. */
export function sttModel() {
  const model = (process.env.GNANI_STT_MODEL ?? PRISMA_V3).trim();
  return model || 'prisma-v2.5';
}
const isV3 = (model) => model === PRISMA_V3;

// Prisma v3.0 takes clips of up to 30 s. Longer WAV answers (the browser allows 60 s) are cut into
// parts a little under that and transcribed one after another.
export const MAX_CLIP_SECONDS = 28;

/**
 * Splits 16-bit PCM WAV audio into parts of at most `seconds`, each with its own header.
 * Audio that is not plain PCM WAV, or that is short enough, comes back as one part.
 * @param {Buffer} wav
 * @returns {Buffer[]}
 */
export function splitWav(wav, seconds = MAX_CLIP_SECONDS) {
  const buf = Buffer.from(wav);
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') return [buf];
  let fmt = null;
  let data = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('latin1', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'fmt ') fmt = { at: at + 8, size };
    if (id === 'data') { data = { at: at + 8, size: Math.min(size, buf.length - at - 8) }; break; }
    at += 8 + size + (size % 2);
  }
  if (!fmt || !data || buf.readUInt16LE(fmt.at) !== 1) return [buf];
  const channels = buf.readUInt16LE(fmt.at + 2);
  const rate = buf.readUInt32LE(fmt.at + 4);
  const bits = buf.readUInt16LE(fmt.at + 14);
  const block = channels * (bits / 8);
  const partBytes = Math.floor((rate * seconds * block) / block) * block;
  if (!partBytes || data.size <= partBytes) return [buf];

  const parts = [];
  for (let off = 0; off < data.size; off += partBytes) {
    const pcm = buf.subarray(data.at + off, data.at + Math.min(data.size, off + partBytes));
    if (pcm.length < rate * block * 0.3) break; // a tail under 0.3 s holds no words
    const head = Buffer.alloc(44);
    head.write('RIFF', 0, 'latin1');
    head.writeUInt32LE(36 + pcm.length, 4);
    head.write('WAVEfmt ', 8, 'latin1');
    head.writeUInt32LE(16, 16);
    head.writeUInt16LE(1, 20);
    head.writeUInt16LE(channels, 22);
    head.writeUInt32LE(rate, 24);
    head.writeUInt32LE(rate * block, 28);
    head.writeUInt16LE(block, 32);
    head.writeUInt16LE(bits, 34);
    head.write('data', 36, 'latin1');
    head.writeUInt32LE(pcm.length, 40);
    parts.push(Buffer.concat([head, pcm]));
  }
  return parts.length ? parts : [buf];
}

/**
 * Transcribes one answer clip with Prisma.
 * @param {Buffer} audio audio bytes (WAV recommended; ≤ 60 s, sent in parts of up to 28 s)
 * @param {{ format?: keyof STT_CONTENT_TYPES, language?: string, callId?: string,
 *   keyterms?: string[], topic?: string, previousText?: string }} [opts]
 *   keyterms / topic / previousText: context for Prisma v3.0 (words to expect, what the call is about,
 *   the question just asked); ignored on v2.5
 * @returns {Promise<{ transcript: string, requestId: string|null, ms: number, model: string, detectedLanguage: string|null }>}
 */
export function transcribe(audio, opts = {}) {
  return prismaQueue(async () => {
    const parts = opts.format && opts.format !== 'wav' ? [audio] : splitWav(audio);
    if (parts.length === 1) return withRetry(() => transcribeNow(audio, opts));
    // One answer in several parts: each part gets the text before it as context, and the texts are joined.
    const started = Date.now();
    const texts = [];
    let last = null;
    for (const part of parts) {
      const previousText = texts.length ? texts.join(' ') : opts.previousText;
      last = await withRetry(() => transcribeNow(part, { ...opts, previousText }));
      if (last.transcript) texts.push(last.transcript);
    }
    return { ...last, transcript: texts.join(' ').trim(), ms: Date.now() - started, parts: parts.length };
  });
}

async function transcribeNow(audio, { format = 'wav', language, callId, keyterms, topic, previousText } = {}) {
  const contentType = STT_CONTENT_TYPES[format];
  if (!contentType) throw new SpeechError(`Prisma does not accept "${format}" audio.`, 400);
  const model = sttModel();
  let languageCode = language || process.env.GNANI_STT_LANGUAGE || 'en-IN';
  // v2.5 takes one language only; v3.0 takes up to four as hints.
  languageCode = isV3(model) ? languageCode.split(',').map(l => l.trim()).filter(Boolean).slice(0, 4).join(',') : languageCode.split(',')[0].trim();

  const form = new FormData();
  form.append('audio_file', new Blob([audio], { type: contentType }), `answer.${format}`);
  if (isV3(model)) form.append('model', model);
  form.append('language_code', languageCode);
  // "transcribe" writes numbers as digits ("nine lakh" → 9,00,000), which helps CTC extraction.
  form.append('format', 'transcribe');
  if (isV3(model)) {
    const terms = (keyterms || []).map(t => String(t).trim()).filter(Boolean).slice(0, 200);
    if (terms.length) form.append('keyterms', JSON.stringify(terms));
    if (topic) form.append('topic', String(topic).slice(0, 1600));
    if (previousText) form.append('previous_text', String(previousText).slice(-600));
  }

  const started = Date.now();
  let status = null;
  let body = null;
  let failure = null;
  try {
    const res = await fetch(STT_URL, { method: 'POST', headers: { 'X-API-Key-ID': apiKey() }, body: form, signal: AbortSignal.timeout(gnaniTimeoutMs()) });
    status = res.status;
    const raw = await res.text().catch(() => '');
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!res.ok || !body?.success) {
      const reason = body?.error?.message || body?.message || body?.detail?.message || (typeof body?.detail === 'string' ? body.detail : '')
        || (Array.isArray(body?.detail) ? body.detail.map(d => d?.msg).filter(Boolean).join('; ') : '') || raw.slice(0, 200);
      failure = `Prisma returned ${res.status}${reason ? `: ${reason}` : ''}`;
      throw new SpeechError(failure, res.status === 429 ? 429 : 502, isRetryableStatus(res.status));
    }
    return {
      transcript: (body.transcript || '').trim(), requestId: body.request_id || null, ms: Date.now() - started,
      model: body.model || model, detectedLanguage: body.detected_language_code || null
    };
  } catch (err) {
    failure = failure || err.message;
    throw err instanceof SpeechError ? err : networkError('Prisma', err);
  } finally {
    logExternalCall({
      service: 'prisma', endpoint: STT_URL, method: 'POST', request_id: body?.request_id || generateRequestId(),
      session_id: callId, payload: { bytes: audio.length, format, model, language_code: languageCode }, response_status: status,
      response_body: body ? { success: body.success, transcript_length: body.transcript?.length ?? 0, model: body.model || null, detected_language: body.detected_language_code || null } : null,
      duration_ms: Date.now() - started, error: failure
    }).catch(() => {});
  }
}

/**
 * Speaks text with Timbre.
 * @param {string} text what the agent says (numbers and amounts are best written as words)
 * @param {{ container?: 'mp3'|'wav'|'ogg', sampleRate?: number, language?: string, callId?: string }} [opts]
 *   language = Timbre language for this line (default GNANI_TTS_LANGUAGE)
 * @returns {Promise<{ audio: Buffer, contentType: string, ms: number }>}
 */
export function speak(text, opts = {}) {
  return timbreQueue(() => withRetry(() => speakNow(text, opts)));
}

async function speakNow(text, { container = 'mp3', sampleRate = 24000, language, callId } = {}) {
  if (!text || !text.trim()) throw new SpeechError('Nothing to speak.', 400);
  const voice = (process.env.GNANI_TTS_VOICE || '').trim();
  if (!voice) throw new SpeechError('GNANI_TTS_VOICE is not set in .env.', 503);

  const payload = {
    text: text.trim(),
    voice,
    model: process.env.GNANI_TTS_MODEL || 'timbre-v2.5',
    language: language || process.env.GNANI_TTS_LANGUAGE || 'auto',
    speed: 1.0,
    audio_config: container === 'mp3'
      ? { container: 'mp3', sample_rate: sampleRate, num_channels: 1, bitrate: '64k' }
      : { container, sample_rate: sampleRate, num_channels: 1, sample_width: 2, encoding: 'linear_pcm' }
  };

  const started = Date.now();
  let status = null;
  let failure = null;
  let size = 0;
  try {
    const res = await fetch(TTS_URL, {
      method: 'POST',
      headers: { 'X-API-Key-ID': apiKey(), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(gnaniTimeoutMs())
    });
    status = res.status;
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      failure = `Timbre returned ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
      throw new SpeechError(failure, res.status === 429 ? 429 : 502, isRetryableStatus(res.status));
    }
    const audio = Buffer.from(await res.arrayBuffer());
    size = audio.length;
    return { audio, contentType: TTS_CONTENT_TYPES[container] || 'application/octet-stream', ms: Date.now() - started };
  } catch (err) {
    failure = failure || err.message;
    throw err instanceof SpeechError ? err : networkError('Timbre', err);
  } finally {
    logExternalCall({
      service: 'timbre', endpoint: TTS_URL, method: 'POST', request_id: generateRequestId(), session_id: callId,
      payload: { chars: payload.text.length, voice, model: payload.model, language: payload.language, container },
      response_status: status, response_body: size ? { bytes: size } : null,
      duration_ms: Date.now() - started, error: failure
    }).catch(() => {});
  }
}

// ── Audio cache (roadmap G.3) ──
// The same lines (HR questions, repeat prompts) are spoken in every call of a batch. Keeping their
// audio in memory saves Timbre credits and ~0.5 s per line. Lost on restart, which is fine.
const AUDIO_CACHE_MAX = 300;
const audioCache = new Map();
// Lines being synthesised right now (key → promise), so simultaneous requests for one line share it.
const pendingVoices = new Map();

function cacheKey(text, container, sampleRate, language) {
  return [
    process.env.GNANI_TTS_VOICE || '', process.env.GNANI_TTS_MODEL || 'timbre-v2.5', language || process.env.GNANI_TTS_LANGUAGE || 'auto',
    container, sampleRate, text.trim()
  ].join('|');
}

/**
 * speak() with an in-memory cache. Same arguments and result, plus `cached`.
 * @param {string} text
 * @param {{ container?: 'mp3'|'wav'|'ogg', sampleRate?: number, language?: string, callId?: string }} [opts]
 * @param {{ speakFn?: typeof speak }} [deps]
 */
export async function speakCached(text, opts = {}, { speakFn = speak } = {}) {
  const key = cacheKey(String(text || ''), opts.container || 'mp3', opts.sampleRate || 24000, opts.language);
  const hit = audioCache.get(key);
  if (hit) {
    // Move to the end so the oldest unused line is dropped first.
    audioCache.delete(key);
    audioCache.set(key, hit);
    return { ...hit, ms: 0, cached: true };
  }
  // Several calls asking for the same new line at once share one Timbre request.
  if (pendingVoices.has(key)) return { ...(await pendingVoices.get(key)), cached: true };
  const pending = speakFn(text, opts);
  pendingVoices.set(key, pending);
  try {
    const voice = await pending;
    audioCache.set(key, { audio: voice.audio, contentType: voice.contentType });
    if (audioCache.size > AUDIO_CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
    return { ...voice, cached: false };
  } finally {
    pendingVoices.delete(key);
  }
}

export function clearAudioCache() {
  audioCache.clear();
  pendingVoices.clear();
}
