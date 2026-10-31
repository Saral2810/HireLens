import { speakCached } from './gnaniSpeech.js';
import { translateQuestions, writeCompanyBriefing } from './brain.js';
import { allowedLanguages, phrases, ttsLanguage } from './callLanguage.js';

/**
 * ─── Pre-voicing ────────────────────────────────────────────────────────────
 * The HR questions, the company briefing and the fixed lines are the same in every call of a
 * campaign. When HR runs a campaign they are voiced once, in every language the campaign allows,
 * so the first candidates do not wait on Timbre for them (and the audio cache serves later calls).
 * Lines with the candidate's name (greeting, closing) and resume questions differ per call and are
 * voiced during the call as before. Runs in the background; a failure only means a slower first call.
 *
 *   PREVOICE_ON_RUN  1 (default) voices lines when a campaign is run; 0 turns it off
 */

export function prevoiceEnabled() {
  return process.env.PREVOICE_ON_RUN !== '0';
}

/**
 * The lines every call of this campaign speaks, per language.
 * @param {{ company_name?: string|null, company_intro?: string|null, job_role: string, job_description?: string|null, call_languages?: string[] }} batch
 * @param {{ question_text: string }[]} questions HR questions
 * @returns {Promise<{ language: string, lines: string[] }[]>}
 */
export async function campaignLines(batch, questions, deps = {}) {
  const translate = deps.translate || translateQuestions;
  const brief = deps.brief || writeCompanyBriefing;
  const out = [];
  for (const language of allowedLanguages(batch.call_languages)) {
    const say = phrases(language);
    const [{ lines: asked }, briefing] = await Promise.all([
      translate(questions.map(q => q.question_text), language),
      brief({ companyName: batch.company_name, jobRole: batch.job_role, companyIntro: batch.company_intro, jobDescription: batch.job_description }, language)
    ]);
    const lines = [say.ready, ...(briefing.text ? [briefing.text] : []), ...asked, say.moveOn, say.notReady];
    out.push({ language, lines: [...new Set(lines.filter(Boolean))] });
  }
  return out;
}

/**
 * Voices every shared line of a campaign into the audio cache.
 * @returns {Promise<{ voiced: number, failed: number }>}
 */
export async function prevoiceCampaign(batch, questions, deps = {}) {
  const speak = deps.speak || speakCached;
  let voiced = 0;
  let failed = 0;
  for (const { language, lines } of await campaignLines(batch, questions, deps)) {
    // One by one: Gnani takes one request at a time per key, and calls in progress share that lane.
    for (const text of lines) {
      try {
        await speak(text, { language: ttsLanguage(language) });
        voiced += 1;
      } catch {
        failed += 1;
      }
    }
  }
  return { voiced, failed };
}
