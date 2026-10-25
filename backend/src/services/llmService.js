import dotenv from 'dotenv';
dotenv.config();

/**
 * ─── LLM SLOT (the "brain") ────────────────────────────────────────────────
 * One generic, OpenAI-compatible chat-completions call. Point it at any model
 * (Evon on llama.cpp/vLLM, or a hosted backup) using .env:
 *
 *   LLM_API_URL   full chat-completions URL, e.g. http://127.0.0.1:8080/v1/chat/completions
 *   LLM_API_KEY   your key
 *   LLM_MODEL     model name (sent in the request body; optional for Azure deployments)
 *   LLM_AUTH_HEADER  'bearer' (default -> "Authorization: Bearer <key>") or 'api-key' (Azure style)
 *
 * The screening prompts that use this slot are added in roadmap Phases B, F and G.
 */

export function isLLMConfigured() {
  return Boolean((process.env.LLM_API_URL || '').trim() && (process.env.LLM_API_KEY || '').trim());
}

/**
 * @param {object} bodyPayload chat-completions request body (messages, temperature, ...)
 * @returns {Promise<Response|null>} the successful response, or null if not configured or failed
 */
export async function callLLM(bodyPayload) {
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
