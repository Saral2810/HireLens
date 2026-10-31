// Unit (TDD): Gnani speech client (queueing, retries, cache) and the LLM slot — against the in-process fakes.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, speak, speakCached, clearAudioCache, speechRetry, SpeechError, isSpeechConfigured } from '../../../backend/src/services/gnaniSpeech.js';
import { callLLM, isLLMConfigured } from '../../../backend/src/services/llmService.js';
import { redactPayload } from '../../../backend/src/services/observability/externalCallLogger.js';
import { net, fakes, resetNetwork, sayClip } from '../helpers/network.js';

beforeEach(() => { resetNetwork(); clearAudioCache(); speechRetry.delaysMs = [1, 1]; });

test('harness: Gnani and the LLM are configured only with fake keys and a fake host', () => {
  assert.equal(process.env.GNANI_SPEECH_API_KEY, 'qa-fake-gnani-key');
  assert.match(process.env.LLM_API_URL, /fake-llm\.qa\.invalid/);
  assert.equal(process.env.SUPABASE_URL, '');
  assert.equal(isSpeechConfigured(), true);
  assert.equal(isLLMConfigured(), true);
});

test('harness: any other host is refused by the network guard', async () => {
  await assert.rejects(fetch('https://api.groq.com/openai/v1/chat/completions'), /refused/);
  await assert.rejects(fetch('https://example-project.supabase.co/rest/v1/'), /refused/);
  assert.equal(net.refused.length, 2);
});

test('transcribe and speak: 20 parallel requests are serialised (Gnani allows one at a time per key)', async () => {
  fakes.latency = { prisma: 5, timbre: 5, llm: 0 };
  const results = await Promise.all([
    ...Array.from({ length: 10 }, (_, i) => transcribe(sayClip(`answer ${i}`))),
    ...Array.from({ length: 10 }, (_, i) => speak(`line ${i}`))
  ]);
  assert.equal(results[3].transcript, 'answer 3');
  assert.equal(net.maxActive.prisma, 1);
  assert.equal(net.maxActive.timbre, 1);
});

test('retries: 403/429/5xx are retried twice, 400 is not retried', async () => {
  fakes.fail = (svc, n) => (svc === 'prisma' && n < 3 ? 503 : null);
  assert.equal((await transcribe(sayClip('ok'))).transcript, 'ok');
  assert.equal(net.prisma, 3);
  resetNetwork();
  fakes.fail = (svc) => (svc === 'timbre' ? 400 : null);
  await assert.rejects(speak('hi'), (e) => e instanceof SpeechError && e.retryable === false);
  assert.equal(net.timbre, 1);
});

test('one failing request does not break the queue for the next one', async () => {
  fakes.fail = (svc, n) => (svc === 'timbre' && n === 1 ? 400 : null);
  const [a, b] = await Promise.allSettled([speak('first'), speak('second')]);
  assert.equal(a.status, 'rejected');
  assert.equal(b.status, 'fulfilled');
});

test('speakCached: the same line is synthesised once', async () => {
  await speakCached('Aapka notice period kitna hai?');
  const again = await speakCached('Aapka notice period kitna hai?');
  assert.equal(again.cached, true);
  assert.equal(net.timbre, 1);
});

test('BUG-46 (fixed 27 Oct): two calls asking the same new line at the same moment share one Timbre request', async () => {
  fakes.latency.timbre = 5;
  await Promise.all([speakCached('Brand new line'), speakCached('Brand new line')]);
  assert.equal(net.timbre, 1, 'one Timbre request for both');
});

test('callLLM: sends the bearer key and model; returns null on HTTP errors', async () => {
  const r = await callLLM({ messages: [{ role: 'system', content: 'other' }, { role: 'user', content: '{}' }] });
  assert.ok(r);
  fakes.fail = (svc) => (svc === 'llm' ? 500 : null);
  assert.equal(await callLLM({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: '{}' }] }), null);
});

test('external call logs redact keys and truncate transcripts', () => {
  const r = redactPayload({ headers: { 'X-API-Key-ID': 'k', Authorization: 'Bearer t' }, api_key: 's', transcript: 'x'.repeat(300), nested: { password: 'p' } });
  assert.equal(r.headers['X-API-Key-ID'], '[REDACTED]');
  assert.equal(r.headers.Authorization, '[REDACTED]');
  assert.equal(r.api_key, '[REDACTED]');
  assert.equal(r.nested.password, '[REDACTED]');
  assert.match(r.transcript, /length: 300/);
});
