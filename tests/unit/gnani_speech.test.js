import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, speak, STT_URL, TTS_URL } from '../../backend/src/services/gnaniSpeech.js';

const realFetch = globalThis.fetch;
let requests;

function mockFetch(responder) {
  globalThis.fetch = async (url, init) => {
    requests.push({ url, init });
    return responder(url, init);
  };
}

beforeEach(() => {
  requests = [];
  process.env.GNANI_SPEECH_API_KEY = 'test-speech-key';
  process.env.GNANI_TTS_VOICE = 'Poorvi';
  process.env.GNANI_TTS_MODEL = 'timbre-v2.5';
  process.env.GNANI_TTS_LANGUAGE = 'hi-en';
  process.env.GNANI_STT_LANGUAGE = 'en-IN';
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('transcribe sends the clip to Prisma as multipart with the key header', async () => {
  mockFetch(() => new Response(JSON.stringify({ success: true, request_id: 'req_1', transcript: ' do mahine ' }), { status: 200 }));
  const result = await transcribe(Buffer.from('RIFFfake'), { format: 'wav' });

  assert.equal(result.transcript, 'do mahine');
  assert.equal(requests[0].url, STT_URL);
  assert.equal(requests[0].init.headers['X-API-Key-ID'], 'test-speech-key');
  const form = requests[0].init.body;
  assert.equal(form.get('language_code'), 'en-IN');
  assert.equal(form.get('format'), 'transcribe');
  assert.equal(form.get('audio_file').type, 'audio/wav');
});

test('transcribe refuses formats Prisma does not accept', async () => {
  await assert.rejects(transcribe(Buffer.from('x'), { format: 'webm' }), /does not accept "webm"/);
});

test('transcribe surfaces Prisma errors with a status', async () => {
  mockFetch(() => new Response(JSON.stringify({ success: false, message: 'bad audio' }), { status: 400 }));
  await assert.rejects(transcribe(Buffer.from('x')), (err) => err.status === 502 && /400: bad audio/.test(err.message));
});

test('speak asks Timbre for MP3 with the configured voice and returns the bytes', async () => {
  mockFetch(() => new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
  const result = await speak('  Namaste  ');

  assert.deepEqual([...result.audio], [1, 2, 3]);
  assert.equal(result.contentType, 'audio/mpeg');
  assert.equal(requests[0].url, TTS_URL);
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual([body.text, body.voice, body.model, body.language], ['Namaste', 'Poorvi', 'timbre-v2.5', 'hi-en']);
  assert.equal(body.audio_config.container, 'mp3');
});

test('speak needs text, a voice and a key', async () => {
  await assert.rejects(speak('   '), /Nothing to speak/);
  delete process.env.GNANI_TTS_VOICE;
  await assert.rejects(speak('hi'), /GNANI_TTS_VOICE/);
  process.env.GNANI_TTS_VOICE = 'Poorvi';
  delete process.env.GNANI_SPEECH_API_KEY;
  await assert.rejects(speak('hi'), /GNANI_SPEECH_API_KEY/);
});
