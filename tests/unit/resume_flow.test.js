import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTextPdf } from '../../backend/scripts/makeTextPdf.js';
import { extractResumeText, looksLikePdf, cleanResumeText } from '../../backend/src/services/resumeParser.js';
import { writeResumeQuestions, fallbackResumeQuestions } from '../../backend/src/services/brain.js';
import { buildQuestionPlan } from '../../backend/src/services/questionPlan.js';

const RESUME_LINES = [
  'Asha Rao - Backend Engineer (made-up resume)',
  'Experience: 4 years at Demo Fintech (Node.js, PostgreSQL, Redis)',
  'Built a payments reconciliation service processing 2M transactions a day',
  'Led migration from monolith to microservices on AWS ECS',
  'Skills: Node.js, TypeScript, PostgreSQL, Kafka, Docker, AWS'
];

const fakeLlm = (content) => async () => ({ json: async () => ({ choices: [{ message: { content } }] }) });

test('extractResumeText reads a text PDF', async () => {
  const r = await extractResumeText(makeTextPdf(RESUME_LINES));
  assert.equal(r.pages, 1);
  assert.equal(r.readable, true);
  assert.match(r.text, /payments reconciliation service/);
  assert.equal(r.truncated, false);
});

test('extractResumeText flags a PDF with no readable text and rejects non-PDFs', async () => {
  assert.equal((await extractResumeText(makeTextPdf(['Page 1']))).readable, false);
  await assert.rejects(extractResumeText(Buffer.from('not a pdf at all')), /PDF file/);
  await assert.rejects(extractResumeText(Buffer.from('%PDF-1.4 broken')), /could not be read/);
  assert.equal(looksLikePdf(Buffer.from('%PDF-1.7')), true);
  assert.equal(cleanResumeText('a \u0007 b\n\n\n\nc'), 'a b\n\nc');
});

test('writeResumeQuestions keeps 3–5 good questions from the brain', async () => {
  const qs = ['Demo Fintech mein reconciliation service kaise banayi?', 'ECS migration mein sabse bada challenge kya tha?',
    'Kafka ka use kis project mein kiya?', 'Postgres performance kaise tune ki?', 'Redis caching kahan lagayi?', 'Sixth extra question here?'];
  const r = await writeResumeQuestions({ resumeText: RESUME_LINES.join('\n'), jobRole: 'Backend Engineer' }, { llm: fakeLlm(JSON.stringify({ questions: qs })) });
  assert.equal(r.source, 'llm');
  assert.equal(r.questions.length, 5);
  assert.deepEqual(r.questions[0], { question_text: qs[0], answer_type: 'text' });
});

test('writeResumeQuestions falls back to general questions when needed', async () => {
  const noText = await writeResumeQuestions({ resumeText: '', jobRole: 'Data Analyst' }, { llm: fakeLlm('{}') });
  assert.equal(noText.source, 'fallback');
  assert.match(noText.questions[1].question_text, /Data Analyst/);

  const tooFew = await writeResumeQuestions({ resumeText: 'x'.repeat(300), jobRole: 'QA' }, { llm: fakeLlm('{"questions":["Only one question here?"]}') });
  assert.equal(tooFew.source, 'fallback');

  const brainDown = await writeResumeQuestions({ resumeText: 'x'.repeat(300), jobRole: 'QA' }, { llm: async () => null });
  assert.equal(brainDown.source, 'fallback');
  assert.equal(fallbackResumeQuestions('QA').length, 3);
});

test('buildQuestionPlan orders intro → project → problems → resume → experience check → HR (by position) → closing', () => {
  const plan = buildQuestionPlan({
    candidate: { name: 'Asha Rao', resume_questions: [{ question_text: 'R1?' }, { question_text: 'R2?', answer_type: 'text' }] },
    batch: { job_role: 'Backend Engineer', company_name: 'Demo Co' },
    hrQuestions: [
      { question_text: 'Expected CTC?', answer_type: 'ctc', position: 1 },
      { question_text: 'Notice period?', answer_type: 'duration', position: 0 }
    ]
  });
  assert.match(plan.intro, /Namaste Asha!.*Demo Co.*Backend Engineer/);
  assert.match(plan.intro, /record/);
  assert.deepEqual(plan.questions.map(q => [q.position, q.source, q.question_text]), [
    [0, 'intro', 'Kya aap abhi baat karne ke liye ready hain?'],
    [1, 'general', 'Shuru karte hain aapke kaam se. Apne kisi ek project ke baare mein bataiye jis par aapko sabse zyada garv hai: aapne kya banaya, aur usme aapka role kya tha?'],
    [2, 'general', 'Us project mein aapko sabse badi problem kya aayi, aur aapne use kaise solve kiya?'],
    [3, 'resume', 'R1?'],
    [4, 'resume', 'R2?'],
    [5, 'general', 'Kya aapne pehle kisi company mein full-time job ki hai, ya aap fresher hain?'],
    [6, 'hr', 'Notice period?'],
    [7, 'hr', 'Expected CTC?']
  ]);
  assert.deepEqual([plan.questions[1].probe, plan.questions[2].probe], [true, true]);
  assert.deepEqual([plan.questions[5].experience_check, plan.questions[5].fresher_skip], [true, true]);
  assert.equal(plan.questions[7].answer_type, 'ctc');
  assert.match(plan.closing, /Dhanyavaad Asha/);
});
