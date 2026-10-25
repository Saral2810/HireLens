import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideTurn, normalizeExtracted, parseJsonReply, MAX_ATTEMPTS } from '../../backend/src/services/brain.js';

// Fake LLM that answers with the given content and records what it was asked.
function fakeLlm(content) {
  const calls = [];
  const llm = async (body) => {
    calls.push(body);
    return { json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return { llm, calls };
}

const Q = 'Aapka current notice period kitna hai?';

test('accepts a clear answer and keeps the extracted value', async () => {
  const { llm, calls } = fakeLlm('{"action":"next","extracted":{"days":60},"say":null}');
  const d = await decideTurn({ question: Q, answerType: 'duration', transcript: 'do mahine', attempt: 1 }, { llm });
  assert.equal(d.action, 'next');
  assert.deepEqual(d.extracted, { days: 60 });
  assert.equal(d.source, 'llm');
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content, /do mahine/);
});

test('asks again with the model\'s line when the answer is unclear', async () => {
  const { llm } = fakeLlm('Sure! {"action":"repeat","extracted":null,"say":"Sorry, notice period phir se bata dijiye?"}');
  const d = await decideTurn({ question: Q, answerType: 'duration', transcript: 'hello aawaz aa rahi hai', attempt: 1 }, { llm });
  assert.equal(d.action, 'repeat');
  assert.equal(d.say, 'Sorry, notice period phir se bata dijiye?');
  assert.equal(d.extracted, null);
});

test('a second unclear answer moves on instead of looping', async () => {
  const { llm } = fakeLlm('{"action":"repeat","extracted":null,"say":"Phir se?"}');
  const d = await decideTurn({ question: Q, answerType: 'duration', transcript: 'kya bola', attempt: MAX_ATTEMPTS }, { llm });
  assert.equal(d.action, 'skip');
  assert.equal(d.say, null);
});

test('silence is repeated without calling the model', async () => {
  const { llm, calls } = fakeLlm('{}');
  const d = await decideTurn({ question: Q, answerType: 'duration', transcript: '  ', attempt: 1 }, { llm });
  assert.equal(d.action, 'repeat');
  assert.equal(d.source, 'rule');
  assert.match(d.say, /notice period/);
  assert.equal(calls.length, 0);
});

test('an unavailable or unreadable brain keeps the call moving with the raw answer', async () => {
  const d1 = await decideTurn({ question: Q, answerType: 'duration', transcript: 'teen mahine' }, { llm: async () => null });
  assert.deepEqual([d1.action, d1.source, d1.extracted], ['next', 'rule', { text: 'teen mahine' }]);
  const { llm } = fakeLlm('I think they said three months');
  const d2 = await decideTurn({ question: Q, answerType: 'duration', transcript: 'teen mahine' }, { llm });
  assert.equal(d2.action, 'next');
});

test('notice period falls back to rule parsing when the model gives no days', async () => {
  const { llm } = fakeLlm('{"action":"next","extracted":{"text":"2 months"},"say":null}');
  const d = await decideTurn({ question: Q, answerType: 'duration', transcript: '2 months' }, { llm });
  assert.deepEqual(d.extracted, { days: 60 });
});

test('normalizeExtracted unwraps nested values and enforces one shape per type', () => {
  assert.deepEqual(normalizeExtracted({ yes_no: { yes: true } }, 'yes_no'), { yes: true });
  assert.deepEqual(normalizeExtracted({ text: { text: 'Pune' } }, 'text'), { text: 'Pune' });
  assert.deepEqual(normalizeExtracted({ lpa: 9, note: 'x' }, 'ctc'), { lpa: 9 });
  assert.equal(normalizeExtracted({ foo: 1 }, 'ctc'), null);
  assert.equal(normalizeExtracted(null, 'ctc'), null);
});

test('parseJsonReply tolerates code fences and stray text', () => {
  assert.deepEqual(parseJsonReply('```json\n{"action":"next"}\n```'), { action: 'next' });
  assert.equal(parseJsonReply('no json here'), null);
  assert.equal(parseJsonReply(''), null);
});
