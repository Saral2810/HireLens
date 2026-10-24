
import dotenv from 'dotenv';
dotenv.config();
import db from '../config/db.js';

/**
 * ─── LLM SLOT (the "brain") ────────────────────────────────────────────────
 * One generic, OpenAI-compatible chat-completions call. Point it at any model
 * (Gnani's LLM, OpenAI, Azure OpenAI, Groq, a local model, ...) using .env:
 *
 *   LLM_API_URL   full chat-completions URL, e.g. https://api.openai.com/v1/chat/completions
 *   LLM_API_KEY   your key
 *   LLM_MODEL     model name (sent in the request body; optional for Azure deployments)
 *   LLM_AUTH_HEADER  'bearer' (default -> "Authorization: Bearer <key>") or 'api-key' (Azure style)
 *
 * If LLM_API_URL / LLM_API_KEY are not set, the offline rule-based analyzer is used.
 */
function isLLMConfigured() {
  return Boolean((process.env.LLM_API_URL || '').trim() && (process.env.LLM_API_KEY || '').trim());
}

async function callLLM(bodyPayload) {
  if (!isLLMConfigured()) return null;
  const url = process.env.LLM_API_URL.trim();
  const key = process.env.LLM_API_KEY.trim();
  const model = (process.env.LLM_MODEL || '').trim();
  const authStyle = (process.env.LLM_AUTH_HEADER || 'bearer').trim().toLowerCase();
  const headers = { 'Content-Type': 'application/json' };
  if (authStyle === 'api-key') headers['api-key'] = key;
  else headers['Authorization'] = `Bearer ${key}`;
  const payload = model ? { ...bodyPayload, model } : bodyPayload;
  try {
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (response.ok) return response;
    const errText = await response.text();
    console.warn(`[LLM Service] LLM API returned ${response.status}: ${errText}`);
  } catch (e) {
    console.error('[LLM Service] Exception calling LLM API:', e);
  }
  return null;
}

async function analyzeTranscript(transcriptJson, callStatus, lead = null) {
  // If call is completely empty/invalid, we can still fallback, but we'll try to process whatever we can if we reached here
  if (!transcriptJson) {
    return {
      success: true,
      sentiment: 'NEUTRAL',
      summary: '{"call_purpose": "Call failed/unanswered"}',
      analysis: {
        call_outcome: "Call failed/unanswered",
        engagement_level: "LOW",
        follow_up_required: false
      },
      booking_confirmed: false
    };
  }

  let messages = [];
  if (Array.isArray(transcriptJson)) {
    messages = transcriptJson;
  } else if (transcriptJson && typeof transcriptJson === 'object') {
    messages = transcriptJson.messages
      || transcriptJson.transcript_data?.messages
      || transcriptJson.transcript_json?.messages
      || transcriptJson.conversation
      || [];
  }

  if (!messages || messages.length === 0) {
    return {
      success: true,
      sentiment: 'NEUTRAL',
      summary: '{"call_purpose": "Simulated call / No transcript generated"}',
      analysis: {
        call_outcome: "Completed",
        engagement_level: "NEUTRAL",
        follow_up_required: false
      },
      booking_confirmed: false
    };
  }

  const formattedText = messages.map(m => `${m.role || m.speaker || 'Unknown'}: ${m.message || m.content || m.text || ''}`).join('\n');

  if (isLLMConfigured()) {
    let onboardingConfig = {};
    if (lead && lead.tenant_id) {
      try {
        onboardingConfig = await db.getOnboardingConfig(lead.tenant_id);
      } catch (e) {
        console.warn('[LLM Service] Failed to fetch onboarding config:', e);
      }
    }

    // ── Analysis prompt (generic template) ──────────────────────────────────
    // Replace this with your own Gnani use-case prompt, or set a per-tenant
    // override in tenant onboarding_config.llm_system_prompt.
    const defaultPrompt = `You are an expert call analyzer for an AI voice-calling platform.
Your job is to analyze ONE AI voicebot call and extract structured information.

══════════════ OUTPUT RULES ══════════════
- Return ONLY one valid JSON object. No markdown, no code fences, no commentary.
- If a value is NOT explicitly stated by the customer, return null. Never guess or invent.
- Booleans must be true or false (never null).

══════════════ CONTEXT ══════════════
Call date (use to resolve relative timeframes): ${new Date().toISOString()}
Timezone for any timestamp: ${process.env.APP_TIMEZONE || 'Asia/Kolkata'}.

══════════════ FIELD RULES ══════════════
summary (string) — 1-2 sentences: topic, customer response, outcome.
reasoning (string) — 1-2 sentences explaining the lead_classification with transcript evidence.
lead_classification — one of: "HOT", "WARM", "COLD", "NOT_INTERESTED", "INVALID", or null.
lead_score (integer 0-100) — how promising this lead is based only on the transcript.
consent_status — "agreed" | "declined" | "unclear" | "not_asked" (consent to the OFFER, not to picking up the call).
consent_reasoning (string) — cite the customer turn(s) behind consent_status.
dnd (boolean) — true if the customer asked not to be called again.
purchase_timeline (boolean) — true if the customer gave a concrete timeframe.
motivation (string|null) — why the customer wants the product, if stated.
callback_time (string|null) — requested callback time, verbatim.
callback_at (string|null) — ISO 8601 timestamp computed from callback_time.
retry_required (boolean) — should the bot call again? false if escalated, closed or dnd.
qa_extracted (boolean) — always true.

Return EXACTLY this shape:
{
  "summary": "string",
  "reasoning": "string",
  "lead_score": 0,
  "product_type": null,
  "dnd": false,
  "purchase_timeline": false,
  "lead_classification": null,
  "consent_status": "not_asked",
  "consent_reasoning": "string",
  "motivation": null,
  "callback_time": null,
  "callback_at": null,
  "retry_required": false,
  "qa_extracted": true
}`;

    const systemPrompt = (onboardingConfig && onboardingConfig.llm_system_prompt) || defaultPrompt;

    const bodyPayload = {
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: systemPrompt
        },

        {
          role: 'user',
          content: `Here is the transcript:\n\n${formattedText}`
        }
      ],
      temperature: 0.2
    };

    console.log(`[LLM Service] Analyzing transcript for status '${callStatus}'...`);
    const successResponse = await callLLM(bodyPayload);

    if (successResponse) {
      try {
        const data = await successResponse.json();
        let rawContent = data.choices[0].message.content || '';
        
        const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          rawContent = jsonMatch[0];
        }
        
        const result = JSON.parse(rawContent);

        let dynamicSummary = result.summary || result.call_summary || null;
        if (!dynamicSummary && result.motivation) {
          dynamicSummary = `Customer inquiry regarding ${result.product_type || 'product'}: ${result.motivation}`;
        }
        if (!dynamicSummary) {
          dynamicSummary = `Outbound conversation completed with classification: ${result.lead_classification || 'WARM'}.`;
        }

        // Calibrated lead scoring based on interaction & transcript analysis
        let leadScore = null;
        if (typeof result.lead_score === 'number' && !isNaN(result.lead_score)) {
          leadScore = Math.max(0, Math.min(100, Math.round(result.lead_score)));
        }

        // Strict requirement: If customer is interested, agreed, or classified HOT, assign 100
        if (
          result.lead_classification === 'HOT' ||
          result.consent_status === 'agreed' ||
          (leadScore !== null && leadScore >= 90)
        ) {
          leadScore = 100;
        } else if (result.dnd === true) {
          leadScore = 0;
        } else if (leadScore === null) {
          // Fallback outcome score based on classification
          const classScores = {
            HOT: 100,
            WARM: 75,
            ALREADY_BOOKED: 85,
            COLD: 35,
            NOT_INTERESTED: 10,
            INVALID: 5
          };
          leadScore = result.lead_classification ? (classScores[result.lead_classification] ?? 45) : 45;
        }

        const analysisData = {
          summary: dynamicSummary,
          reasoning: result.reasoning || 'No reasoning provided by model',
          lead_score: leadScore,
          product_type: result.product_type || lead?.product_type || 'Unknown',
          dnd: !!result.dnd,
          purchase_timeline: !!result.purchase_timeline,
          lead_classification: result.lead_classification || null,
          consent_status: result.consent_status || null,
          consent_reasoning: result.consent_reasoning || null,
          motivation: result.motivation || null,
          callback_time: result.callback_time || null,
          callback_at: result.callback_at || null,
          retry_required: !!result.retry_required,
          qa_extracted: true
        };

        return {
          success: true,
          ...analysisData,
          analysis: analysisData
        };
      } catch (parseErr) {
        console.error('[LLM Service] Failed to parse JSON from AI response:', parseErr);
        throw new Error('LLM Response Parsing Failed: ' + parseErr.message);
      }
    }
  }

  console.warn('[LLM Service] All LLM providers failed or none configured. Returning offline fallback.');
  
  // Offline deterministic fallback calibrated to yesterday's transcript interactions
  const textLower = formattedText.toLowerCase();
  let dnd = false;
  let retry_required = true;
  let lead_classification = null;
  let lead_score = 45;
  let consent_status = 'not_asked';
  let consent_reasoning = null;

  if (
    textLower.includes('do not call') ||
    textLower.includes('stop calling') ||
    textLower.includes('dnd') ||
    textLower.includes('number hata') ||
    textLower.includes('delete my number') ||
    textLower.includes('mat call karo')
  ) {
    dnd = true;
    retry_required = false;
    lead_classification = 'NOT_INTERESTED';
    lead_score = 0;
    consent_status = 'declined';
    consent_reasoning = 'Customer requested DND / do not call';
  } else if (
    textLower.includes('link bhej') ||
    textLower.includes('bhej do') ||
    textLower.includes('send link') ||
    textLower.includes('send details') ||
    textLower.includes('haan bhej') ||
    textLower.includes('whatsapp kar') ||
    textLower.includes('haan dekha tha') ||
    textLower.includes('yes interested') ||
    textLower.includes('chahiye')
  ) {
    lead_classification = 'HOT';
    retry_required = false;
    lead_score = 100; // Explicit 100 for interested leads
    consent_status = 'agreed';
    consent_reasoning = 'Customer confirmed interest or agreed to receive details/link';
  } else if (
    textLower.includes('english') ||
    textLower.includes('speak in english') ||
    textLower.includes('dont know hindi') ||
    textLower.includes('don\'t know hindi')
  ) {
    // Language Barrier (e.g. Sudharson)
    lead_classification = 'WARM';
    retry_required = true;
    lead_score = 60;
    consent_status = 'unclear';
    consent_reasoning = 'Customer requested communication in English';
  } else if (
    textLower.includes('kitne ka') ||
    textLower.includes('details') ||
    textLower.includes('rate') ||
    textLower.includes('interest') ||
    textLower.includes('byaj') ||
    textLower.includes('emi') ||
    textLower.includes('baad me') ||
    textLower.includes('call back') ||
    textLower.includes('shaam ko')
  ) {
    lead_classification = 'WARM';
    retry_required = false;
    lead_score = 75;
    consent_status = 'unclear';
  } else if (
    textLower.includes('not interested') ||
    textLower.includes('nahi chahiye') ||
    textLower.includes('nahin chahiye') ||
    textLower.includes('nahi lena') ||
    textLower.includes('no need') ||
    textLower.includes('requirement nahi') ||
    textLower.includes('phone rakho')
  ) {
    lead_classification = 'NOT_INTERESTED';
    retry_required = false;
    lead_score = 10;
    consent_status = 'declined';
    consent_reasoning = 'Customer explicitly declined the offer';
  } else if (formattedText.trim().length > 40) {
    // Connected and dropped mid-pitch before decision
    lead_classification = null;
    retry_required = true;
    lead_score = 50;
    consent_status = 'not_asked';
  } else {
    // Silent answer or immediate drop
    lead_classification = null;
    retry_required = true;
    lead_score = 25;
    consent_status = 'not_asked';
  }

  const fallbackData = {
    summary: dnd
      ? 'Customer requested DND / do not call.'
      : (lead_score === 100
        ? 'Customer expressed interest and requested offer details.'
        : (lead_classification ? `Call completed with classification: ${lead_classification}.` : 'Call connected but ended mid-pitch before a decision was reached.')),
    reasoning: dnd ? 'Customer requested DND' : (lead_score === 100 ? 'Customer requested link or confirmed interest' : 'Offline fallback transcript analysis'),
    lead_score: lead_score,
    product_type: lead?.product_type || 'Unknown',
    dnd: dnd,
    purchase_timeline: false,
    lead_classification: lead_classification,
    consent_status: consent_status,
    consent_reasoning: consent_reasoning,
    motivation: null,
    callback_time: null,
    callback_at: null,
    retry_required: retry_required,
    qa_extracted: true
  };

  return {
    success: true,
    ...fallbackData,
    analysis: fallbackData
  };
}

async function scoreFreeTextColumn(text, instruction) {
  if (!isLLMConfigured() || !text || !instruction) {
    return 0;
  }

  const systemPrompt = `You are an AI lead-scoring engine. Your job is to read the text and evaluate it strictly based on the following instruction: "${instruction}".
Return ONLY a numeric integer score. Do not provide any explanation, prose, or punctuation. Just the number.`;

  const bodyPayload = {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: String(text) }
    ],
    temperature: 0.1,
    max_completion_tokens: 10
  };

  const response = await callLLM(bodyPayload);
  if (response) {
    try {
      const data = await response.json();
      const rawContent = data.choices?.[0]?.message?.content || '';
      const scoreMatch = rawContent.match(/-?\d+/);
      if (scoreMatch) return parseInt(scoreMatch[0], 10);
    } catch (e) {
      console.error('[LLM Service] Could not parse score response:', e);
    }
  }
  return 0; // Default fallback score
}

export {
  analyzeTranscript,
  scoreFreeTextColumn
};
