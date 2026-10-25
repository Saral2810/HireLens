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
  constructor(message, status) {
    super(message);
    this.name = 'SpeechError';
    this.status = status;
  }
}

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
export async function transcribe(audio, { format = 'wav', language, callId } = {}) {
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
    body = await res.json().catch(() => null);
    if (!res.ok || !body?.success) {
      failure = `Prisma returned ${res.status}${body?.message ? `: ${body.message}` : ''}`;
      throw new SpeechError(failure, res.status === 429 ? 429 : 502);
    }
    return { transcript: (body.transcript || '').trim(), requestId: body.request_id || null, ms: Date.now() - started };
  } catch (err) {
    failure = failure || err.message;
    throw err instanceof SpeechError ? err : new SpeechError(`Prisma request failed: ${err.message}`, 502);
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
export async function speak(text, { container = 'mp3', sampleRate = 24000, callId } = {}) {
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
      throw new SpeechError(failure, res.status === 429 ? 429 : 502);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    size = audio.length;
    return { audio, contentType: TTS_CONTENT_TYPES[container] || 'application/octet-stream', ms: Date.now() - started };
  } catch (err) {
    failure = failure || err.message;
    throw err instanceof SpeechError ? err : new SpeechError(`Timbre request failed: ${err.message}`, 502);
  } finally {
    logExternalCall({
      service: 'timbre', endpoint: TTS_URL, method: 'POST', request_id: generateRequestId(), session_id: callId,
      payload: { chars: payload.text.length, voice, model: payload.model, language: payload.language, container },
      response_status: status, response_body: size ? { bytes: size } : null,
      duration_ms: Date.now() - started, error: failure
    }).catch(() => {});
  }
}
