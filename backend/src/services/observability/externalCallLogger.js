import crypto from 'crypto';
import db from '../../config/db.js';

const REDACT_KEY_REGEX = /secret|password|token|api.?key/i;
const REDACT_HEADER_NAMES = ['client-secret', 'x-api-key-id', 'authorization', 'x-api-key'];

/**
 * Generates a short random alphanumeric request ID.
 */
export function generateRequestId() {
  return crypto.randomBytes(4).toString('hex');
}

/**
 * Redacts sensitive fields from payloads and truncates transcripts per specification.
 */
export function redactPayload(val, keyName = '') {
  if (val === null || val === undefined) {
    return val;
  }

  // Redact based on key name matching /secret|password|token|api.?key/i
  if (typeof keyName === 'string' && REDACT_KEY_REGEX.test(keyName)) {
    return '[REDACTED]';
  }

  // Transcript truncation rule (3f): log length + first 100 chars only
  if (typeof keyName === 'string' && keyName.toLowerCase() === 'transcript') {
    if (val === null || val === undefined) {
      return val;
    }
    if (typeof val === 'string') {
      return val.length > 100 ? `${val.substring(0, 100)}... (length: ${val.length})` : val;
    }
    const str = JSON.stringify(val);
    if (!str) return val;
    return str.length > 100 ? `${str.substring(0, 100)}... (length: ${str.length})` : str;
  }

  if (Array.isArray(val)) {
    return val.map((item) => redactPayload(item));
  }

  if (typeof val === 'object') {
    const redacted = {};
    for (const [k, v] of Object.entries(val)) {
      const kLower = k.toLowerCase();
      if (REDACT_HEADER_NAMES.includes(kLower) || REDACT_KEY_REGEX.test(k)) {
        redacted[k] = '[REDACTED]';
      } else if (kLower === 'transcript') {
        if (v === null || v === undefined) {
          redacted[k] = v;
        } else if (typeof v === 'string') {
          redacted[k] = v.length > 100 ? `${v.substring(0, 100)}... (length: ${v.length})` : v;
        } else {
          const str = JSON.stringify(v);
          redacted[k] = str && str.length > 100 ? `${str.substring(0, 100)}... (length: ${str.length})` : str;
        }
      } else {
        redacted[k] = redactPayload(v, k);
      }
    }
    return redacted;
  }

  return val;
}

/**
 * Logs an external HTTP call to console with prefix [ExtCall][service=X endpoint=Y req=ID]
 * and persists to the external_call_logs table (when Supabase is connected).
 *
 * @param {Object} options
 * @param {string} options.service - Service identifier (prisma, timbre, llm, ...)
 * @param {string} options.endpoint - Outbound URL
 * @param {string} options.method - HTTP method (GET, POST, etc.)
 * @param {string} options.request_id - Correlation request ID
 * @param {string} [options.session_id] - Optional screening call ID, so usage can be summed per call
 * @param {*} [options.payload] - Outbound request payload (headers/body)
 * @param {number} [options.response_status] - HTTP response status code
 * @param {*} [options.response_body] - Response body content or object
 * @param {number} [options.duration_ms] - Call duration in milliseconds
 * @param {string} [options.error] - Optional error message if call failed
 */
export async function logExternalCall({
  service,
  endpoint,
  method,
  request_id,
  session_id,
  payload,
  response_status,
  response_body,
  duration_ms,
  error
}) {
  const reqId = request_id || generateRequestId();
  const sanitizedPayload = redactPayload(payload);

  let sanitizedResponseBody = response_body;
  if (typeof response_body === 'string') {
    try {
      sanitizedResponseBody = JSON.parse(response_body);
    } catch {
      sanitizedResponseBody = response_body.length > 1000 ? `${response_body.substring(0, 1000)}... (truncated)` : response_body;
    }
  }
  sanitizedResponseBody = redactPayload(sanitizedResponseBody);

  const prefix = `[ExtCall][service=${service} endpoint=${endpoint} req=${reqId}]`;
  const statusStr = response_status !== undefined && response_status !== null ? `status=${response_status}` : 'status=ERR';
  const durationStr = duration_ms !== undefined && duration_ms !== null ? `${duration_ms}ms` : '0ms';
  const errorStr = error ? ` error=${error}` : '';

  console.log(`${prefix} ${method} ${statusStr} ${durationStr}${errorStr}`);

  const record = {
    service,
    endpoint,
    method,
    request_id: reqId,
    session_id: session_id ? String(session_id) : null,
    payload: sanitizedPayload || null,
    response_status: response_status !== undefined && response_status !== null ? Number(response_status) : null,
    response_body: sanitizedResponseBody || null,
    duration_ms: duration_ms !== undefined && duration_ms !== null ? Math.round(duration_ms) : null,
    error: error ? String(error) : null,
    created_at: new Date().toISOString()
  };

  try {
    if (db.supabase) {
      await db.supabase.from('external_call_logs').insert([record]);
    }
  } catch (dbErr) {
    if (dbErr.code !== 'PGRST205' && !dbErr.message?.includes('PGRST205') && !dbErr.message?.includes('does not exist')) {
      console.warn(`[ExtCall Logger] Failed to save external call log to database:`, dbErr.message);
    }
  }

  return record;
}

export default {
  logExternalCall,
  generateRequestId,
  redactPayload
};
