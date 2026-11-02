/**
 * ─── ATS score ──────────────────────────────────────────────────────────────
 * How well a resume would do in an Applicant Tracking System for this campaign's role, out of 100.
 * Computed from the resume text when the candidate uploads it (no model, so it is the same every
 * time and costs nothing). Five checks, each with a tip HR or the candidate can act on:
 *
 *   Keywords from the job   40  share of the role's and job description's key terms found in the resume
 *   Standard sections       20  contact details, education, experience or projects, skills (5 each)
 *   Measurable results      15  numbers and percentages in the work described (5 or more = full)
 *   Action words            10  built, led, designed, improved ... (8 or more = full)
 *   Length and readability  15  300–900 words is ideal; very short or very long resumes lose points
 *
 * A resume whose text cannot be read (a scanned or image-only PDF) scores 0: an ATS cannot read it either.
 */

export const ATS_VERSION = 1;

const STOPWORDS = new Set(`a an and are as at be been but by can for from has have in is it its of on or our that the this
to was we were will with you your their they them who what when where which while would should could about above after
again all also am any because before being below between both do does doing down during each few further here how into
just more most no nor not now only other out over own same so some such than then there these those through too under
until up very why role job candidate candidates team teams work working company years year experience experienced strong
good great excellent ability able required requirements responsibilities responsible preferred plus must etc using use
including knowledge understanding skills skill looking join new well within across based per like help make sure
build building builds service services engineer engineers developer developers position opening opportunity day days
environment end hands-on solutions solution products product systems system`.split(/\s+/));

// Words that look like noise in a job description but are real skills.
const SHORT_SKILLS = new Set(['c', 'r', 'go', 'ai', 'ml', 'ui', 'ux', 'qa', 'bi', 'hr', 'pm', 'sql', 'aws', 'gcp', 'api', 'css', 'git', 'ios', 'nlp', 'etl', 'seo', 'crm', 'erp', 'sap']);

const ACTION_WORDS = /\b(built|build|led|lead|designed|design|developed|develop|implemented|implement|created|launched|improved|improve|optimi[sz]ed|reduced|increased|automated|managed|delivered|deployed|migrated|architected|owned|scaled|mentored|analy[sz]ed|resolved|integrated|shipped|achieved|streamlined|refactored|tested|established|coordinated|negotiated|trained)\b/gi;

/** Key terms of the job: from the job role and description, most frequent first (at most 25). */
export function jobKeywords(jobRole, jobDescription) {
  const text = `${jobRole || ''} ${jobRole || ''} ${jobDescription || ''}`.toLowerCase();
  const counts = new Map();
  for (const raw of text.match(/[a-z][a-z0-9+#.]*[a-z0-9+#]|[a-z]/g) || []) {
    const word = raw.replace(/\.+$/, '');
    if (STOPWORDS.has(word)) continue;
    if (word.length < 3 && !SHORT_SKILLS.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 25).map(([w]) => w);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** True when `word` appears in the resume as a whole term ("node.js", "c++" and "go" included), singular or plural. */
function hasTerm(resumeLower, word) {
  const stem = word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
  return new RegExp(`(^|[^a-z0-9+#])${escapeRe(stem)}s?($|[^a-z0-9+#])`).test(resumeLower);
}

const SECTIONS = [
  { key: 'contact', label: 'Contact details', test: (t) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t) || /(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/.test(t) },
  { key: 'education', label: 'Education', test: (t) => /\b(education|b\.?\s?tech|b\.?e\.?|m\.?\s?tech|b\.?sc|m\.?sc|bca|mca|mba|b\.?com|degree|university|college|institute|cgpa|gpa)\b/i.test(t) },
  { key: 'experience', label: 'Experience or projects', test: (t) => /\b(experience|employment|work history|internship|projects?)\b/i.test(t) },
  { key: 'skills', label: 'Skills', test: (t) => /\b(skills|technologies|tech stack|tools|competencies)\b/i.test(t) }
];

/**
 * @param {{ resumeText: string|null, readable?: boolean, jobRole?: string, jobDescription?: string|null }} input
 * @returns {{ score: number, breakdown: { version: number, checks: object[], matched: string[], missing: string[], words: number, readable: boolean } }}
 */
export function computeAtsScore({ resumeText, readable = true, jobRole, jobDescription }) {
  const text = String(resumeText || '');
  const lower = text.toLowerCase();
  const words = (text.match(/\S+/g) || []).length;
  if (!readable || words < 30) {
    const tip = 'The resume text could not be read. Upload a text PDF (exported from Word or Google Docs), not a scan or image.';
    return { score: 0, breakdown: { version: ATS_VERSION, readable: false, words, matched: [], missing: [], checks: [{ key: 'readable', label: 'Readable by an ATS', max: 100, points: 0, tip }] } };
  }

  const keywords = jobKeywords(jobRole, jobDescription);
  const matched = keywords.filter(k => hasTerm(lower, k));
  const missing = keywords.filter(k => !matched.includes(k));
  const keywordPoints = keywords.length ? Math.round((40 * matched.length) / keywords.length) : 20;

  const sections = SECTIONS.map(s => ({ ...s, found: s.test(text) }));
  const sectionPoints = sections.filter(s => s.found).length * 5;

  const metrics = (text.match(/\b\d+(\.\d+)?\s?(%|percent|x\b|k\b|lakh|crore|users|customers|ms\b|hours|days|people|members)|[₹$]\s?\d+/gi) || []).length;
  const metricPoints = Math.min(15, metrics * 3);

  // Different action words used (repeating one word does not count twice).
  const actions = new Set((text.match(ACTION_WORDS) || []).map(w => w.toLowerCase())).size;
  const actionPoints = Math.min(10, Math.round((10 * Math.min(actions, 8)) / 8));

  const lengthPoints = words < 150 ? 5 : words < 300 ? 10 : words <= 900 ? 15 : words <= 1300 ? 11 : 7;

  const checks = [
    { key: 'keywords', label: 'Keywords from the job', max: 40, points: keywordPoints,
      tip: missing.length ? `Add these terms where they are true for you: ${missing.slice(0, 8).join(', ')}.` : 'Covers the key terms of the job.' },
    { key: 'sections', label: 'Standard sections', max: 20, points: sectionPoints,
      tip: sections.some(s => !s.found) ? `Add a clear heading for: ${sections.filter(s => !s.found).map(s => s.label.toLowerCase()).join(', ')}.` : 'All standard sections are there.' },
    { key: 'metrics', label: 'Measurable results', max: 15, points: metricPoints,
      tip: metricPoints < 15 ? 'Show results with numbers (users, %, time saved, money).' : 'Results are backed by numbers.' },
    { key: 'action_words', label: 'Action words', max: 10, points: actionPoints,
      tip: actionPoints < 10 ? 'Start points with action words such as built, led, improved, reduced.' : 'Uses strong action words.' },
    { key: 'length', label: 'Length and readability', max: 15, points: lengthPoints,
      tip: words < 300 ? `Only ${words} words: add detail on projects and results.` : words > 900 ? `${words} words: keep it to one or two pages.` : 'Good length.' }
  ];
  const score = Math.max(0, Math.min(100, checks.reduce((n, c) => n + c.points, 0)));
  return { score, breakdown: { version: ATS_VERSION, readable: true, words, matched, missing, checks } };
}
