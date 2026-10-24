import { scoreFreeTextColumn } from './llmService.js';

/**
 * Computes the lead score (0-100) dynamically using an advanced weighted algorithm.
 * Evaluates demographic fit, source quality, behavioral signals, recency decay, and prior interactions.
 */
export async function computeLeadScore(lead, weights = {}) {
  // Evaluate Custom Scoring Rules from config
  let customRulesScore = 0;
  if (weights.custom_scoring_rules && Array.isArray(weights.custom_scoring_rules)) {
    for (const rule of weights.custom_scoring_rules) {
      let val = null;
      if (rule.field.startsWith('supporting_data.')) {
        const key = rule.field.split('.')[1];
        const item = lead.supporting_data?.find(d => d.key === key);
        val = item ? item.value : null;
      } else {
        val = lead[rule.field] || lead.raw_data?.[rule.field];
        // If not found, intelligently check supporting_data dynamically
        if (val === undefined || val === null) {
           const item = lead.supporting_data?.find(d => d.key === rule.field);
           val = item ? item.value : null;
        }
      }

      if (val !== null && val !== undefined) {
        if (rule.type === 'match' && val === rule.value) {
          customRulesScore += rule.points;
        } else if (rule.type === 'in' && Array.isArray(rule.value) && rule.value.includes(val)) {
          customRulesScore += rule.points;
        } else if (rule.type === 'range') {
          const numVal = parseFloat(val);
          if (!isNaN(numVal) && numVal >= rule.min && numVal <= rule.max) {
             customRulesScore += rule.points;
          }
        } else if (rule.type === 'text_match' && String(val).toLowerCase() === String(rule.value).toLowerCase()) {
          customRulesScore += rule.points;
        } else if (rule.type === 'free_text' && rule.instruction) {
          const llmScore = await scoreFreeTextColumn(val, rule.instruction);
          customRulesScore += llmScore;
        }
      }
    }
    return Math.min(100, Math.max(0, customRulesScore));
  }

  // Hook: add a tenant-specific fallback scoring formula here if no custom rules are configured.


  const rawData = lead.raw_data || {};
  
  // 1. Demographic & Qualification Fit (Max 35 points)
  let demographicScore = 0;
  let demoMatches = 0;
  
  // Income & Budget Signals
  if (rawData.monthly_income || rawData.budget) {
    const value = Number(rawData.monthly_income || rawData.budget);
    if (value >= 150000 || value >= 5000000) demographicScore += 15;
    else if (value >= 75000 || value >= 2500000) demographicScore += 10;
    else demographicScore += 5;
    demoMatches++;
  }
  
  // Credit Score or Qualification
  if (rawData.credit_score || rawData.qualification) {
    const cs = Number(rawData.credit_score || 0);
    const qual = String(rawData.qualification).toLowerCase();
    if (cs >= 750 || qual.includes('degree') || qual.includes('graduate')) demographicScore += 10;
    else if (cs >= 650 || qual.includes('diploma')) demographicScore += 6;
    else demographicScore += 3;
    demoMatches++;
  }

  // Location / Property / Course Intent
  if (rawData.property_type || rawData.location_preference || rawData.course_interest) {
    demographicScore += 10; 
    demoMatches++;
  }

  // Automotive / Tractors Intent
  if (rawData.business_type || rawData.product_type || rawData.brand_name || rawData.model_name || rawData.expected_purchase_date) {
    const timeline = String(rawData.expected_purchase_date || '').toLowerCase();
    if (timeline.includes('immediate') || timeline.includes('this month') || timeline.includes('1 month')) {
      demographicScore += 15;
    } else if (timeline.includes('3 month') || timeline.includes('soon')) {
      demographicScore += 10;
    } else {
      demographicScore += 5;
    }
    
    if (rawData.brand_name || rawData.model_name) {
      demographicScore += 5;
    }
    demoMatches++;
  }

  // Baseline if missing data
  if (demoMatches === 0) {
    // Generate a deterministic jitter based on phone number so all cold leads don't get exactly 66
    const phoneStr = lead.phone ? String(lead.phone) : '0';
    let hash = 0;
    for (let i = 0; i < phoneStr.length; i++) {
      hash = (hash << 5) - hash + phoneStr.charCodeAt(i);
      hash = hash & hash;
    }
    const jitter = Math.abs(hash % 11) - 5; // -5 to +5
    demographicScore = 15 + jitter;
  }

  // 2. Source Quality (Max 20 points)
  let sourceScore = 10; // Default
  if (lead.source) {
    const source = lead.source.trim().toLowerCase();
    if (source.includes('referral') || source.includes('inbound')) sourceScore = 20;
    else if (source.includes('organic') || source.includes('direct')) sourceScore = 16;
    else if (source.includes('paid') || source.includes('ads')) sourceScore = 12;
    else if (source.includes('cold') || source.includes('list')) sourceScore = 6;
  }

  // 3. Recency Decay (Max 25 points) - Exponential decay based on time since lead creation
  let recencyScore = 25;
  const createdTime = lead.created_at ? new Date(lead.created_at).getTime() : Date.now();
  const hoursSince = Math.max(0, (Date.now() - createdTime) / (1000 * 60 * 60));
  
  if (hoursSince <= 1) recencyScore = 25;
  else if (hoursSince <= 24) recencyScore = 20;
  else if (hoursSince <= 72) recencyScore = 12; // 3 days
  else if (hoursSince <= 168) recencyScore = 6; // 1 week
  else recencyScore = 2; // Stale

  // 4. Behavioral & Engagement Signals (Max 20 points)
  let behavioralScore = 0;
  if (rawData.pages_visited) {
    behavioralScore += Math.min(10, Number(rawData.pages_visited) * 2);
  }
  if (rawData.video_watched === true || rawData.video_watched === 'true') {
    behavioralScore += 5;
  }
  if (rawData.downloaded_brochure || rawData.course_viewed) {
    behavioralScore += 5;
  }

  // If no behavioral tracking, assign a median score to prevent punishing clean leads
  if (behavioralScore === 0) behavioralScore = 10;

  // Aggregate Total Base Score
  let totalScore = demographicScore + sourceScore + recencyScore + behavioralScore + customRulesScore;

  // Apply Prior Interaction Penalties/Bonuses
  const priorOutcome = rawData.prior_outcome || lead.status;
  if (priorOutcome) {
    const outcome = priorOutcome.trim().toLowerCase();
    if (outcome.includes('callback') || outcome.includes('interested')) totalScore += 15;
    else if (outcome.includes('no_answer') || outcome.includes('voicemail')) totalScore -= 10;
    else if (outcome.includes('rejected') || outcome.includes('not_interested')) totalScore -= 30;
  }

  return Math.max(0, Math.min(100, Math.round(totalScore)));
}

/**
 * Dynamically adjusts lead score based on post-call sentiment, LLM classification, AI analysis, and engagement.
 * Uses lead_classification as the primary signal when available (most accurate), then falls back to
 * sentiment + attitude + engagement adjustments. Ensures the score perfectly reflects the temperature
 * of the lead post-interaction.
 */
export function computeDynamicScore(baseScore, sentiment, attitude = 'neutral', engagement = 'medium', analysis = {}) {
  // ─── STRICT RULE: Interested leads immediately receive 100 ──────────────────
  if (
    analysis?.lead_score === 100 ||
    analysis?.lead_classification === 'HOT' ||
    analysis?.consent_status === 'agreed'
  ) {
    return 100;
  }

  // ─── STRICT RULE: DND leads immediately receive 0 ───────────────────────────
  if (analysis?.dnd === true) {
    return 0;
  }

  // If the analysis already carries an interaction-calibrated lead_score, return it
  if (typeof analysis?.lead_score === 'number' && !isNaN(analysis.lead_score)) {
    return Math.max(0, Math.min(100, Math.round(analysis.lead_score)));
  }

  let adjustment = 0;
  const s = (sentiment || '').toLowerCase();
  const rawEngagement = engagement || analysis?.customer_analysis?.engagement || analysis?.engagement_level || 'medium';
  const att = (attitude || analysis?.customer_analysis?.attitude || 'neutral').toLowerCase();
  const eng = rawEngagement.toLowerCase();

  // ─── LLM Lead Classification (highest priority signal) ───────────────────────
  const classification = (analysis?.lead_classification || '').toUpperCase();
  if (classification) {
    switch (classification) {
      case 'HOT':
        return 100;
      case 'WARM':
        adjustment += 15;
        break;
      case 'ALREADY_BOOKED':
        adjustment += 10;
        break;
      case 'COLD':
        break;
      case 'NOT_INTERESTED':
        return 10;
      case 'INVALID':
        return 5;
      default:
        break;
    }
  }

  // ─── Hook: tenant-specific boosts go here (e.g. appointment booked → high score) ───

  // ─── Promise-to-Pay Boost (collections use-cases) ────────────────────────────
  const isPtp = classification === 'HOT' && (analysis.ptp_amount != null || analysis.ptp_date);
  if (isPtp) {
    return 100;
  }
  if (analysis.budget_fit && analysis.budget_fit.toLowerCase() === 'matched') {
    adjustment += 25;
  }

  // ─── Callback Intent Boost ───────────────────────────────────────────────────
  if (analysis.callback_time || analysis.callback_at) {
    adjustment += 12;
  }

  // ─── Sentiment Shift (secondary) ─────────────────────────────────────────────
  if (!classification || classification === 'COLD') {
    if (s.includes('pos')) adjustment += 15;
    else if (s.includes('neg')) adjustment -= 20;
  }

  // ─── Attitude Shift ──────────────────────────────────────────────────────────
  if (att.includes('cooperative') || att.includes('interested')) adjustment += 8;
  else if (att.includes('hostile') || att.includes('angry')) adjustment -= 15;
  else if (att.includes('skeptical')) adjustment -= 5;

  // ─── Engagement Shift ────────────────────────────────────────────────────────
  if (eng.includes('high')) adjustment += 8;
  else if (eng.includes('low')) adjustment -= 8;

  // ─── Purchase Timeline Boost ─────────────────────────────────────────────────
  if (analysis.purchase_timeline === true) {
    adjustment += 10;
  }

  // ─── AMD Voicemail Guard ──────────────────────────────────────────────────────
  if (analysis.amd_result &&
      ['amd_voicemail', 'machine_confirmed', 'voicemail'].includes(
        String(analysis.amd_result).toLowerCase()
      )) {
    return 15;
  }

  return Math.max(0, Math.min(100, Math.round(baseScore + adjustment)));
}

/**
 * Extracts all customer spoken text from arbitrary transcript structures.
 */
function extractCustomerSpeech(transcript) {
  if (!transcript) return '';
  if (typeof transcript === 'string') return transcript.toLowerCase();

  let msgs = [];
  if (Array.isArray(transcript)) {
    msgs = transcript;
  } else if (transcript && Array.isArray(transcript.messages)) {
    msgs = transcript.messages;
  } else if (typeof transcript === 'object') {
    msgs = Object.values(transcript);
  }

  const custTurns = msgs.filter(m => {
    const speaker = String(m?.speaker || m?.role || '').toLowerCase();
    return speaker === 'customer' || speaker === 'user' || speaker === 'human';
  });

  if (custTurns.length > 0) {
    return custTurns.map(m => m?.message || m?.text || '').join(' ').toLowerCase();
  }

  // Fallback: entire transcript text
  return msgs.map(m => m?.message || m?.text || '').join(' ').toLowerCase();
}

/**
 * Computes the post-call outcome score (0-100) based on:
 * 1. Explicit customer interest (Guaranteed 100)
 * 2. LLM-provided lead_score and classification
 * 3. Deep transcript dialogue analysis (inquiries, objections, language barrier, hangup timing)
 * 4. Call duration and connection characteristics
 *
 * Calibration Rubric:
 * - 100: Interested / Agreed / Link Requested / Loan Needed ("haan bhej do", "send link", "interested")
 * - 75-85: Warm / Inquiring about rate, EMI, loan details / Callback requested
 * - 60: Language Barrier (Politely requested English)
 * - 45-55: Connected & Dropped Mid-Pitch (Picked up, heard greeting, dropped before decision)
 * - 25-30: Connected Dead Air / Silence
 * - 15-20: Voicemail / Automated Screening Machine
 * - 10: Explicitly Not Interested ("nahi chahiye", "no requirement")
 * - 0: DND / Suppression ("database se number hata do", "don't call")
 */
export function computeOutcomeScore(
  classification,
  analysis = {},
  transcript = null,
  duration = 0,
  disposition = 'completed',
  lead = {}
) {
  const normClass = classification ? String(classification).toUpperCase().trim() : null;
  const custText = extractCustomerSpeech(transcript);
  const dur = Number(duration) || 0;

  // 1. STRICT RULE: Customer is INTERESTED -> 100
  if (
    normClass === 'HOT' ||
    analysis?.lead_classification === 'HOT' ||
    analysis?.consent_status === 'agreed' ||
    analysis?.lead_score === 100
  ) {
    return 100;
  }

  // 2. STRICT RULE: DND requested -> 0
  if (
    analysis?.dnd === true ||
    custText.includes('database se number hata') ||
    custText.includes('do not call') ||
    custText.includes('stop calling') ||
    custText.includes('dnd') ||
    custText.includes('delete my number')
  ) {
    return 0;
  }

  // 3. Transcript Dialogue Inspection: Explicit Interest phrases -> 100
  if (
    custText.includes('link bhej') ||
    custText.includes('bhej do') ||
    custText.includes('send link') ||
    custText.includes('send details') ||
    custText.includes('haan bhej') ||
    custText.includes('whatsapp kar') ||
    custText.includes('haan dekha tha') ||
    custText.includes('yes interested') ||
    custText.includes('loan chahiye')
  ) {
    return 100;
  }

  // 4. If LLM provided an interaction lead_score, use it directly
  if (typeof analysis?.lead_score === 'number' && !isNaN(analysis.lead_score)) {
    if (analysis.lead_score >= 90) return 100;
    return Math.max(0, Math.min(100, Math.round(analysis.lead_score)));
  }

  // 5. Transcript Dialogue: Language Barrier -> 60
  if (
    custText.includes('english') ||
    custText.includes('speak in english') ||
    custText.includes('dont know hindi') ||
    custText.includes('don\'t know hindi')
  ) {
    return 60;
  }

  // 6. Transcript Dialogue: Inquiries / Details / Callback -> 75 - 85
  if (
    custText.includes('interest rate') ||
    custText.includes('byaj') ||
    custText.includes('rate of interest') ||
    custText.includes('kitne ka') ||
    custText.includes('kitna amount') ||
    custText.includes('emi') ||
    custText.includes('baad me call') ||
    custText.includes('shaam ko') ||
    analysis?.callback_time ||
    analysis?.callback_at
  ) {
    return 75;
  }

  // 7. Transcript Dialogue: Not Interested -> 10
  if (
    normClass === 'NOT_INTERESTED' ||
    custText.includes('not interested') ||
    custText.includes('nahi chahiye') ||
    custText.includes('nahin chahiye') ||
    custText.includes('nahi lena') ||
    custText.includes('no need') ||
    custText.includes('requirement nahi') ||
    custText.includes('phone rakho')
  ) {
    return 10;
  }

  // 8. Explicit Standard Classification Map
  const map = {
    HOT: 100,
    ALREADY_BOOKED: 85,
    WARM: 75,
    COLD: 35,
    NOT_INTERESTED: 10,
    INVALID: 5
  };

  if (normClass && map[normClass] !== undefined) {
    return map[normClass];
  }

  // 9. Voicemail or Automated Screener Check
  const amdResult = String(analysis?.amd_result || disposition || '').toLowerCase();
  if (
    amdResult.includes('voicemail') ||
    amdResult.includes('machine') ||
    custText.includes('record your message') ||
    custText.includes('leave a message') ||
    custText.includes('at the tone')
  ) {
    return 15;
  }

  // 10. Connected Call Duration & Engagement Analysis
  // If call was connected and customer spoke or call lasted beyond initial greeting (> 12s)
  if (custText.length > 10 || dur >= 12) {
    // Answered, heard pitch, but hung up mid-pitch before decision
    return 50;
  }

  if (dur >= 4) {
    // Quick drop / dead air
    return 25;
  }

  // Fallback for missing/unclear data
  return 30;
}
