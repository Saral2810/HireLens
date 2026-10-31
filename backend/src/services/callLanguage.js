/**
 * ─── Call language ──────────────────────────────────────────────────────────
 * The candidate picks the language of their call before it starts:
 *   mixed  English + Hindi (Hinglish). The default: the agent speaks Hinglish and understands both.
 *   en     English only
 *   hi     Hindi only (the agent's own lines are written in Devanagari)
 * The choice is saved in calls.question_plan.language, so every turn of the call uses it.
 *
 * Speech settings per language (each falls back to the main GNANI_* value):
 *   GNANI_STT_LANGUAGE_EN / GNANI_STT_LANGUAGE_HI   Prisma language_code (default en-IN / hi-IN,en-IN; v2.5 uses the first)
 *   GNANI_TTS_LANGUAGE_EN / GNANI_TTS_LANGUAGE_HI   Timbre language (default GNANI_TTS_LANGUAGE)
 */

export const CALL_LANGUAGES = Object.freeze(['mixed', 'en', 'hi']);
export const DEFAULT_CALL_LANGUAGE = 'mixed';

/** A supported language code; anything else becomes the default. */
export function callLanguage(value) {
  return CALL_LANGUAGES.includes(value) ? value : DEFAULT_CALL_LANGUAGE;
}

/** The languages a campaign allows (batches.call_languages), in the standard order; all when unset. */
export function allowedLanguages(list) {
  const picked = CALL_LANGUAGES.filter(l => Array.isArray(list) && list.includes(l));
  return picked.length ? picked : [...CALL_LANGUAGES];
}

/** The candidate's choice if the campaign allows it, else the campaign's first language. */
export function pickLanguage(value, allowed = CALL_LANGUAGES) {
  return allowed.includes(value) ? value : (allowed.includes(DEFAULT_CALL_LANGUAGE) ? DEFAULT_CALL_LANGUAGE : allowed[0]);
}

/** Prisma language_code for this call. */
export function sttLanguage(language) {
  const base = process.env.GNANI_STT_LANGUAGE || 'en-IN';
  if (language === 'en') return process.env.GNANI_STT_LANGUAGE_EN || 'en-IN';
  // Prisma v3.0 takes several language hints, so a Hindi call still understands English words.
  if (language === 'hi') return process.env.GNANI_STT_LANGUAGE_HI || 'hi-IN,en-IN';
  return base;
}

/** Timbre language for this call. */
export function ttsLanguage(language) {
  const base = process.env.GNANI_TTS_LANGUAGE || 'auto';
  if (language === 'en') return process.env.GNANI_TTS_LANGUAGE_EN || base;
  if (language === 'hi') return process.env.GNANI_TTS_LANGUAGE_HI || base;
  return base;
}

/** How the brain is told which language to write in. */
export const LANGUAGE_FOR_MODEL = Object.freeze({
  mixed: 'spoken Hinglish (Hindi and English mixed) in Latin script',
  en: 'simple spoken Indian English',
  hi: 'simple spoken Hindi in Devanagari script (common English job words like CTC, notice period, project may stay in English)'
});

/** The agent's fixed lines in each language. */
export const PHRASES = Object.freeze({
  mixed: {
    intro: ({ name, company, role }) => `Namaste${name ? ` ${name}` : ''}! Main${company ? ` ${company} ki taraf se` : ''} AI screening assistant bol rahi hoon, ${role} role ke liye.`
      + ' Yeh call record ho rahi hai aur lagbhag saat minute ki hogi.',
    ready: 'Kya aap abhi baat karne ke liye ready hain?',
    proudProject: 'Shuru karte hain aapke kaam se. Apne kisi ek project ke baare mein bataiye jis par aapko sabse zyada garv hai: aapne kya banaya, aur usme aapka role kya tha?',
    problems: 'Us project mein aapko sabse badi problem kya aayi, aur aapne use kaise solve kiya?',
    experienceCheck: 'Kya aapne pehle kisi company mein full-time job ki hai, ya aap fresher hain?',
    closing: ({ name }) => `Dhanyavaad${name ? ` ${name}` : ''}! Aapke saare answers record ho gaye hain. HR team jaldi aapse contact karegi. Aapka din shubh ho.`,
    notReady: 'Koi baat nahi! Jab aap ready hon, tab is page par wapas aakar Start call dabaiye. Dhanyavaad.',
    notReadyLimit: 'Koi baat nahi. Aap kaafi baar ready nahi the, isliye HR team aapse contact karegi. Dhanyavaad.',
    moveOn: 'Koi baat nahi, aage badhte hain.',
    repeat: (question) => `Sorry, main sun nahi paayi. ${question}`
  },
  en: {
    intro: ({ name, company, role }) => `Hello${name ? ` ${name}` : ''}! I am the AI screening assistant${company ? ` from ${company}` : ''}, calling about the ${role} role.`
      + ' This call is recorded and will take about seven minutes.',
    ready: 'Are you ready to talk now?',
    proudProject: 'Let us start with your work. Tell me about one project you are most proud of: what did you build, and what was your role in it?',
    problems: 'What was the biggest problem you faced in that project, and how did you solve it?',
    experienceCheck: 'Have you worked in a full-time job at a company before, or are you a fresher?',
    closing: ({ name }) => `Thank you${name ? ` ${name}` : ''}! All your answers have been recorded. The HR team will contact you soon. Have a great day.`,
    notReady: 'No problem! When you are ready, come back to this page and press Start call. Thank you.',
    notReadyLimit: 'No problem. Since you were not ready a few times, the HR team will contact you. Thank you.',
    moveOn: 'No problem, let us move on.',
    repeat: (question) => `Sorry, I could not hear that. ${question}`
  },
  hi: {
    intro: ({ name, company, role }) => `नमस्ते${name ? ` ${name}` : ''}! मैं${company ? ` ${company} की तरफ़ से` : ''} AI screening assistant बोल रही हूँ, ${role} role के लिए।`
      + ' यह कॉल रिकॉर्ड हो रही है और लगभग सात मिनट की होगी।',
    ready: 'क्या आप अभी बात करने के लिए तैयार हैं?',
    proudProject: 'शुरुआत आपके काम से करते हैं। अपने किसी एक project के बारे में बताइए जिस पर आपको सबसे ज़्यादा गर्व है: आपने क्या बनाया, और उसमें आपका role क्या था?',
    problems: 'उस project में आपको सबसे बड़ी problem क्या आई, और आपने उसे कैसे solve किया?',
    experienceCheck: 'क्या आपने पहले किसी company में full-time job की है, या आप fresher हैं?',
    closing: ({ name }) => `धन्यवाद${name ? ` ${name}` : ''}! आपके सारे जवाब रिकॉर्ड हो गए हैं। HR टीम जल्दी आपसे संपर्क करेगी। आपका दिन शुभ हो।`,
    notReady: 'कोई बात नहीं! जब आप तैयार हों, तब इस पेज पर वापस आकर Start call दबाइए। धन्यवाद।',
    notReadyLimit: 'कोई बात नहीं। आप कई बार तैयार नहीं थे, इसलिए HR टीम आपसे संपर्क करेगी। धन्यवाद।',
    moveOn: 'कोई बात नहीं, आगे बढ़ते हैं।',
    repeat: (question) => `माफ़ कीजिए, मैं सुन नहीं पाई। ${question}`
  }
});

export function phrases(language) {
  return PHRASES[callLanguage(language)];
}
