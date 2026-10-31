import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { callLanguage, sttLanguage, ttsLanguage, phrases } from '../../backend/src/services/callLanguage.js';
import { buildQuestionPlan, skipForFresher, spokenText } from '../../backend/src/services/questionPlan.js';
import { nextQuestion, notAskedRow, isFresherCall } from '../../backend/src/services/callFlow.js';
import { decideTurn, soundsLikeFresher, translateQuestions, clearTranslationCache } from '../../backend/src/services/brain.js';
import { displayValue } from '../../backend/src/services/results.js';

function fakeLlm(content) {
  const calls = [];
  const llm = async (body) => {
    calls.push(body);
    return { json: async () => ({ choices: [{ message: { content } }] }) };
  };
  return { llm, calls };
}

const HR = [
  { question_text: 'Aapka current notice period kitna hai?', answer_type: 'duration', position: 0 },
  { question_text: 'Aapki current CTC kitni hai?', answer_type: 'ctc', position: 1 },
  { question_text: 'Aapki expected CTC kitni hai?', answer_type: 'ctc', position: 2 },
  { question_text: 'Kya aap hybrid kaam kar sakte hain?', answer_type: 'yes_no', position: 3 }
];

beforeEach(() => clearTranslationCache());

test('callLanguage: English + Hindi is the default for anything unknown', () => {
  assert.equal(callLanguage(undefined), 'mixed');
  assert.equal(callLanguage('fr'), 'mixed');
  assert.equal(callLanguage('en'), 'en');
  assert.equal(callLanguage('hi'), 'hi');
});

test('speech settings per language fall back to the main values', () => {
  assert.equal(sttLanguage('mixed'), process.env.GNANI_STT_LANGUAGE || 'en-IN');
  assert.equal(sttLanguage('en'), 'en-IN');
  assert.equal(sttLanguage('hi'), 'hi-IN,en-IN');
  assert.equal(ttsLanguage('en'), process.env.GNANI_TTS_LANGUAGE || 'auto');
});

test('buildQuestionPlan speaks the chosen language and keeps HR wording', () => {
  const plan = buildQuestionPlan({ candidate: { name: 'Asha Rao' }, batch: { job_role: 'QA', company_name: 'Demo Co' }, hrQuestions: HR, language: 'hi' });
  assert.equal(plan.language, 'hi');
  assert.match(plan.intro, /^नमस्ते Asha!.*Demo Co/);
  assert.equal(plan.questions[0].question_text, phrases('hi').ready);
  assert.equal(plan.questions[1].question_text, phrases('hi').proudProject);
  assert.equal(plan.questions[3].question_text, phrases('hi').experienceCheck);
  assert.equal(plan.questions[4].question_text, HR[0].question_text);
  assert.match(plan.closing, /धन्यवाद Asha/);
});

test('notice period and current CTC are marked as skipped for freshers; expected CTC is not', () => {
  assert.deepEqual(HR.map(skipForFresher), [true, true, false, false]);
  const plan = buildQuestionPlan({ candidate: { name: 'A' }, batch: { job_role: 'QA' }, hrQuestions: HR });
  // 3 = the "full-time job or fresher?" check, 4 and 5 = notice period and current CTC
  assert.deepEqual(plan.questions.filter(q => q.fresher_skip).map(q => q.position), [3, 4, 5]);
});

test('nextQuestion passes over fresher questions only for a fresher', () => {
  const plan = buildQuestionPlan({ candidate: { name: 'A' }, batch: { job_role: 'QA' }, hrQuestions: HR });
  assert.equal(nextQuestion(plan, 2).question.position, 3);
  const fresher = nextQuestion(plan, 2, { fresher: true });
  assert.equal(fresher.question.position, 6, 'expected CTC');
  assert.deepEqual(fresher.notAsked.map(q => q.position), [3, 4, 5]);
  assert.deepEqual(nextQuestion(plan, 7), { question: null, notAsked: [] });
});

test('a not-asked answer reads "Not asked (fresher)" and the flag is found on the transcript', () => {
  const row = notAskedRow({ position: 5, question_text: 'Aapki current CTC kitni hai?', source: 'hr', answer_type: 'ctc' });
  assert.equal(row.outcome, 'skipped');
  assert.equal(displayValue(row), 'Not asked (fresher)');
  assert.equal(isFresherCall([{ speaker: 'candidate', text: 'x', fresher: true }]), true);
  assert.equal(isFresherCall([{ speaker: 'agent', text: 'fresher', fresher: true }]), false);
});

test('soundsLikeFresher: the word in any script, unless denied', () => {
  assert.equal(soundsLikeFresher('Main fresher hoon'), true);
  assert.equal(soundsLikeFresher('मैं फ्रेशर हूँ'), true);
  assert.equal(soundsLikeFresher("I'm not a fresher, 3 years experience"), false);
  assert.equal(soundsLikeFresher('fresher nahi hoon'), false);
  assert.equal(soundsLikeFresher('Do saal ka experience hai'), false);
});

test('decideTurn: the model flag decides, a non-boolean is not trusted, the word is a backup', async () => {
  const yes = await decideTurn({ question: 'Q', transcript: 'abhi college khatam hua' }, fakeLlm('{"action":"next","extracted":{"text":"x"},"say":null,"fresher":true}'));
  assert.equal(yes.fresher, true);
  const no = await decideTurn({ question: 'Q', transcript: 'main fresher hoon' }, fakeLlm('{"action":"next","extracted":{"text":"x"},"say":null,"fresher":false}'));
  assert.equal(no.fresher, false);
  const missing = await decideTurn({ question: 'Q', transcript: 'main fresher hoon' }, fakeLlm('{"action":"next","extracted":{"text":"x"},"say":null}'));
  assert.equal(missing.fresher, true);
  const text = await decideTurn({ question: 'Q', transcript: 'kuch bhi' }, fakeLlm('{"action":"next","extracted":{"text":"x"},"say":null,"fresher":"true"}'));
  assert.equal(text.fresher, false);
});

test('decideTurn: the call language reaches the model and the silence line', async () => {
  const { llm, calls } = fakeLlm('{"action":"next","extracted":{"text":"x"},"say":null}');
  await decideTurn({ question: 'Q', transcript: 'hello there', language: 'en' }, { llm });
  assert.match(calls[0].messages[1].content, /Indian English/);
  const silent = await decideTurn({ question: 'Where are you based?', transcript: '', language: 'en' }, { llm });
  assert.equal(silent.say, 'Sorry, I could not hear that. Where are you based?');
});

test('translateQuestions: Hinglish is left alone; translations are cached; a bad reply keeps the wording', async () => {
  const none = fakeLlm('{}');
  assert.deepEqual((await translateQuestions(['a b c'], 'mixed', none)).lines, ['a b c']);
  assert.equal(none.calls.length, 0);

  const good = fakeLlm('{"lines":["What is your notice period?"]}');
  const first = await translateQuestions(['Aapka notice period kitna hai?'], 'en', good);
  assert.deepEqual(first.lines, ['What is your notice period?']);
  const again = await translateQuestions(['Aapka notice period kitna hai?'], 'en', good);
  assert.equal(again.source, 'cache');
  assert.equal(good.calls.length, 1);

  const bad = await translateQuestions(['One', 'Two two'], 'hi', fakeLlm('{"lines":["only one"]}'));
  assert.deepEqual(bad.lines, ['One', 'Two two']);
  assert.equal(bad.source, 'fallback');
});

test('spokenText prefers the translation', () => {
  assert.equal(spokenText({ question_text: 'Hinglish', spoken_text: 'English' }), 'English');
  assert.equal(spokenText({ question_text: 'Hinglish' }), 'Hinglish');
});
