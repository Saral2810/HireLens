import dotenv from 'dotenv';
import { logExternalCall, generateRequestId } from './observability/externalCallLogger.js';

dotenv.config();

/**
 * ─── Gnani Speech APIs ──────────────────────────────────────────────────────
 * Prisma v2.5 (speech → text, REST, clips up to 60 s) and Timbre (text → speech, REST).
 * Docs: docs.gnani.ai/api/STT/speech-to-text and docs.gnani.ai/api/TTS/tts-inference
 *
 *   GNANI_SPEECH_API_KEY  sent as the X-API-Key-ID header
 *   GNANI_STT_LANGUAGE    en-IN (accepts Hindi–English mixed speech, returns Latin script)
 *   GNANI_TTS_MODEL       timbre-v2.5 | timbre-v3.0
 *   GNANI_TTS_VOICE       e.g. Poorvi (the Hinglish voice for timbre-v2.5)
 *   GNANI_TTS_LANGUAGE    hi-en | en-IN | hi-IN | auto ...
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
const timbreQueue = serialQueue();

function apiKey() {
  const key = (process.env.GNANI_SPEECH_API_KEY || '').trim();
  if (!key) throw new SpeechError('GNANI_SPEECH_API_KEY is not set in .env.', 503);
  return key;
}

export function isSpeechConfigured() {
  return Boolean((process.env.GNANI_SPEECH_API_KEY || '').trim() && (process.env.GNANI_TTS_VOICE || '').trim());
}

/**
 * Transcribes one answer clip with Prisma.
 * @param {Buffer} audio audio bytes (WAV recommended; ≤ 60 s)
 * @param {{ format?: keyof STT_CONTENT_TYPES, language?: string, callId?: string }} [opts]
 * @returns {Promise<{ transcript: string, requestId: string|null, ms: number }>}
 */
export function transcribe(audio, opts = {}) {
  return prismaQueue(() => withRetry(() => transcribeNow(audio, opts)));
}

async function transcribeNow(audio, { format = 'wav', language, callId } = {}) {
  const contentType = STT_CONTENT_TYPES[format];
  if (!contentType) throw new SpeechError(`Prisma does not accept "${format}" audio.`, 400);

  const form = new FormData();
  form.append('audio_file', new Blob([audio], { type: contentType }), `answer.${format}`);
  form.append('language_code', language || process.env.GNANI_STT_LANGUAGE || 'en-IN');
  // "transcribe" writes numbers as digits ("nine lakh" → 9,00,000), which helps CTC extraction.
  form.append('format', 'transcribe');

  const started = Date.now();
  let status = null;
  let body = null;
  let failure = null;
  try {
    const res = await fetch(STT_URL, { method: 'POST', headers: { 'X-API-Key-ID': apiKey() }, body: form });
    status = res.status;
    const raw = await res.text().catch(() => '');
    try { body = JSON.parse(raw); } catch { body = null; }
    if (!res.ok || !body?.success) {
      const reason = body?.message || body?.detail?.message || (typeof body?.detail === 'string' ? body.detail : '') || raw.slice(0, 200);
      failure = `Prisma returned ${res.status}${reason ? `: ${reason}` : ''}`;
      throw new SpeechError(failure, res.status === 429 ? 429 : 502, isRetryableStatus(res.status));
    }
    return { transcript: (body.transcript || '').trim(), requestId: body.request_id || null, ms: Date.now() - started };
  } catch (err) {
    failure = failure || err.message;
    throw err instanceof SpeechError ? err : new SpeechError(`Prisma request failed: ${err.message}`, 502, true);
  } finally {
    logExternalCall({
      service: 'prisma', endpoint: STT_URL, method: 'POST', request_id: body?.request_id || generateRequestId(),
      session_id: callId, payload: { bytes: audio.length, format }, response_status: status,
      response_body: body ? { success: body.success, transcript_length: body.transcript?.length ?? 0 } : null,
      duration_ms: Date.now() - started, error: failure
    }).catch(() => {});
  }
}

/**
 * Speaks text with Timbre.
 * @param {string} text what the agent says (numbers and amounts are best written as words)
 * @param {{ container?: 'mp3'|'wav'|'ogg', sampleRate?: number, callId?: string }} [opts]
 * @returns {Promise<{ audio: Buffer, contentType: string, ms: number }>}
 */
export function speak(text, opts = {}) {
  return timbreQueue(() => withRetry(() => speakNow(text, opts)));
}

async function speakNow(text, { container = 'mp3', sampleRate = 24000, callId } = {}) {
  if (!text || !text.trim()) throw new SpeechError('Nothing to speak.', 400);
  const voice = (process.env.GNANI_TTS_VOICE || '').trim();
  if (!voice) throw new SpeechError('GNANI_TTS_VOICE is not set in .env.', 503);

  const payload = {
    text: text.trim(),
    voice,
    model: process.env.GNANI_TTS_MODEL || 'timbre-v2.5',
    language: process.env.GNANI_TTS_LANGUAGE || 'auto',
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
      body: JSON.stringify(payload)
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
    throw err instanceof SpeechError ? err : new SpeechError(`Timbre request failed: ${err.message}`, 502, true);
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

function cacheKey(text, container, sampleRate) {
  return [
    process.env.GNANI_TTS_VOICE || '', process.env.GNANI_TTS_MODEL || 'timbre-v2.5', process.env.GNANI_TTS_LANGUAGE || 'auto',
    container, sampleRate, text.trim()
  ].join('|');
}

/**
 * speak() with an in-memory cache. Same arguments and result, plus `cached`.
 * @param {string} text
 * @param {{ container?: 'mp3'|'wav'|'ogg', sampleRate?: number, callId?: string }} [opts]
 * @param {{ speakFn?: typeof speak }} [deps]
 */
export async function speakCached(text, opts = {}, { speakFn = speak } = {}) {
  const key = cacheKey(String(text || ''), opts.container || 'mp3', opts.sampleRate || 24000);
  const hit = audioCache.get(key);
  if (hit) {
    // Move to the end so the oldest unused line is dropped first.
    audioCache.delete(key);
    audioCache.set(key, hit);
    return { ...hit, ms: 0, cached: true };
  }
  const voice = await speakFn(text, opts);
  audioCache.set(key, { audio: voice.audio, contentType: voice.contentType });
  if (audioCache.size > AUDIO_CACHE_MAX) audioCache.delete(audioCache.keys().next().value);
  return { ...voice, cached: false };
}

export function clearAudioCache() {
  audioCache.clear();
}
