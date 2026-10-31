// Unit (TDD): what happens when Gnani or the LLM stops answering. Kept in its own file because, before
// BUG-09 was fixed, a hung request blocked the shared speech queue for the rest of the process.
// Fixed 27 Oct: every request has a deadline (GNANI_TIMEOUT_MS, LLM_TIMEOUT_MS); shortened here.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { transcribe, speak, speechRetry, SpeechError } from '../../../backend/src/services/gnaniSpeech.js';
import { callLLM } from '../../../backend/src/services/llmService.js';
import { decideTurn } from '../../../backend/src/services/brain.js';
import { fakes, resetNetwork, sayClip } from '../helpers/network.js';

const within = (promise, ms) => Promise.race([promise.then(() => 'settled', () => 'settled'), new Promise(r => setTimeout(() => r('still waiting'), ms))]);

beforeEach(() => {
  resetNetwork();
  speechRetry.delaysMs = [1, 1];
  process.env.GNANI_TIMEOUT_MS = '200';
  process.env.LLM_TIMEOUT_MS = '200';
});

test('BUG-09 fixed: an LLM request that never answers is given up after LLM_TIMEOUT_MS (returns null → fallback)', async () => {
  fakes.hang = (svc) => svc === 'llm';
  const started = Date.now();
  assert.equal(await callLLM({ messages: [{ role: 'system', content: 'x' }, { role: 'user', content: '{}' }] }), null);
  assert.ok(Date.now() - started < 1500);
});

test('BUG-09 fixed: a turn still completes when the LLM hangs (rule-based fallback keeps the call moving)', async () => {
  fakes.hang = (svc) => svc === 'llm';
  const d = await decideTurn({ question: 'City?', transcript: 'Pune' });
  assert.deepEqual([d.action, d.source], ['next', 'rule']);
});

test('BUG-09 fixed: one Timbre request that never answers no longer blocks later voice lines', async () => {
  fakes.hang = (svc, n) => svc === 'timbre' && n === 1;
  const first = speak('this one hangs once, then the retry works');
  assert.equal(await within(speak('another candidate, another line'), 1500), 'settled');
  assert.equal((await first).audio.toString(), 'QA-MP3:this one hangs once, then the retry works');
});

test('BUG-09 fixed: one stuck Prisma transcription no longer freezes the queue', async () => {
  fakes.hang = (svc, n) => svc === 'prisma' && n === 1;
  transcribe(sayClip('stuck')).catch(() => {});
  assert.equal(await within(transcribe(sayClip('next person')), 1500), 'settled');
});

test('a request that hangs on every try ends with a retryable 504 SpeechError, then the queue moves on', async () => {
  fakes.hang = (svc, n) => svc === 'prisma' && n <= 3;
  await assert.rejects(transcribe(sayClip('never')), (e) => e instanceof SpeechError && e.status === 504 && e.retryable && /did not answer/.test(e.message));
  assert.equal((await transcribe(sayClip('after'))).transcript, 'after');
});
