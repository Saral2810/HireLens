/**
 * Validates a single lead's fields during ingestion.
 * @param {object} lead The lead data object
 * @returns {object} { isValid: boolean, errors: string[] }
 */
export function validateLead(lead) {
  const errors = [];

  if (!lead) {
    return { isValid: false, errors: ['Lead payload is required'] };
  }

  // tenant_id validation
  if (!lead.tenant_id || typeof lead.tenant_id !== 'string' || lead.tenant_id.trim() === '') {
    errors.push('tenant_id is required and must be a non-empty string');
  }

  // phone validation
  if (lead.phone != null) {
    if (typeof lead.phone === 'number') {
      if (isNaN(lead.phone)) {
        lead.phone = '';
      } else {
        // Handle floating point / scientific notation numbers from JSON / Excel
        lead.phone = Number.isInteger(lead.phone) ? String(lead.phone) : String(BigInt(Math.round(lead.phone)));
      }
    } else {
      lead.phone = String(lead.phone);
    }
  }
  
  if (typeof lead.phone === 'string') {
    const pLow = lead.phone.trim().toLowerCase();
    if (pLow === 'nan' || pLow === 'null' || pLow === 'undefined') {
      lead.phone = '';
    }
  }

  if (!lead.phone || typeof lead.phone !== 'string' || lead.phone.trim() === '') {
    errors.push('Phone number is required');
  } else {
    // Sanitize and validate Indian mobile / phone numbers
    const cleaned = cleanPhone(lead.phone);
    // MVP scope requires 10 digits, optionally starting with +91 or 91 country code prefix
    if (!/^(?:\+?91)?\d{10}$/.test(cleaned)) {
      errors.push('phone must be exactly 10 digits or start with +91 country code prefix');
    } else {
      lead.phone = cleaned;
    }
  }

  // source validation
  if (!lead.source || typeof lead.source !== 'string' || lead.source.trim() === '') {
    errors.push('source is required and must be a non-empty string');
  }

  // email validation (optional)
  if (lead.email) {
    if (typeof lead.email !== 'string') {
      errors.push('email must be a string');
    } else {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(lead.email.trim())) {
        errors.push('email is invalid');
      }
    }
  }

  // name validation: do not reject on missing name; route nameless leads to generic greeting fallback ('Customer')
  if (!lead.name || typeof lead.name !== 'string' || lead.name.trim() === '') {
    lead.name = 'Customer';
  } else {
    // Normalize casing (Title Case) for call scripts/WhatsApp templates
    lead.name = lead.name.trim().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
  }

  // raw_data validation (optional)
  if (lead.raw_data !== undefined && lead.raw_data !== null && (typeof lead.raw_data !== 'object' || Array.isArray(lead.raw_data))) {
    errors.push('raw_data must be a JSON object');
  } else if (lead.raw_data && lead.raw_data.budget !== undefined) {
    if (isNaN(Number(lead.raw_data.budget))) {
      errors.push('budget must be a numeric value');
    }
  }

  // HR candidate fields (optional): lift them from top-level or raw_data and normalize
  errors.push(...normalizeCandidateFields(lead));

  return {
    isValid: errors.length === 0,
    errors
  };
}

// HR candidate columns on the leads table, with the CSV/API header names HR teams commonly use.
// Headers are matched case-insensitively with spaces/dashes treated as underscores ("Notice Period" → notice_period).
const CANDIDATE_FIELD_ALIASES = {
  job_role: ['job_role', 'role', 'position', 'designation', 'job_title', 'applied_for'],
  current_company: ['current_company', 'company', 'current_employer', 'employer'],
  experience_years: ['experience_years', 'experience', 'total_experience', 'years_of_experience', 'exp'],
  current_ctc: ['current_ctc', 'ctc', 'current_salary'],
  expected_ctc: ['expected_ctc', 'expected_salary'],
  notice_period_days: ['notice_period_days', 'notice_period', 'notice'],
  skills: ['skills', 'key_skills', 'skill_set'],
  resume_url: ['resume_url', 'resume', 'resume_link', 'cv', 'cv_url'],
  interview_slot: ['interview_slot', 'interview_time', 'interview_date']
};

export const CANDIDATE_FIELDS = Object.keys(CANDIDATE_FIELD_ALIASES);
export const SCREENING_STATUSES = ['pending', 'shortlisted', 'maybe', 'rejected', 'not_interested'];

const NUMERIC_CANDIDATE_FIELDS = ['experience_years', 'current_ctc', 'expected_ctc'];

function normalizeKey(key) {
  return String(key).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Converts a notice period like "30", "2 months", "1 week" or "Immediate" into days.
 * @returns {number|null} days, or null if it can't be read
 */
export function parseNoticePeriodDays(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
  const str = String(value).trim().toLowerCase();
  if (/immediate|serving|^0$/.test(str)) return 0;
  const num = parseFloat(str);
  if (isNaN(num) || num < 0) return null;
  if (str.includes('month')) return Math.round(num * 30);
  if (str.includes('week')) return Math.round(num * 7);
  return Math.round(num);
}

/**
 * Fills lead.<candidate field> from the lead itself or from raw_data (any alias header),
 * and coerces numbers, notice period, dates and URLs. Mutates the lead like validateLead does.
 * @param {object} lead
 * @returns {string[]} validation errors
 */
export function normalizeCandidateFields(lead) {
  const errors = [];
  const sources = [lead, lead.raw_data && typeof lead.raw_data === 'object' ? lead.raw_data : {}];
  const lookups = sources.map(src => {
    const map = new Map();
    for (const [k, v] of Object.entries(src)) {
      if (!isBlank(v)) map.set(normalizeKey(k), v);
    }
    return map;
  });

  for (const [field, aliases] of Object.entries(CANDIDATE_FIELD_ALIASES)) {
    let value;
    for (const map of lookups) {
      const alias = aliases.find(a => map.has(a));
      if (alias) { value = map.get(alias); break; }
    }

    if (isBlank(value)) {
      delete lead[field];
      continue;
    }

    if (NUMERIC_CANDIDATE_FIELDS.includes(field)) {
      const num = typeof value === 'number' ? value : parseFloat(String(value).replace(/,/g, ''));
      if (isNaN(num) || num < 0) {
        errors.push(`${field} must be a non-negative number`);
        continue;
      }
      lead[field] = num;
    } else if (field === 'notice_period_days') {
      const days = parseNoticePeriodDays(value);
      if (days === null) {
        errors.push('notice_period must be a number of days, "N months", "N weeks" or "Immediate"');
        continue;
      }
      lead[field] = days;
    } else if (field === 'interview_slot') {
      const date = new Date(value);
      if (isNaN(date.getTime())) {
        errors.push('interview_slot must be a valid date/time');
        continue;
      }
      lead[field] = date.toISOString();
    } else if (field === 'resume_url') {
      const url = String(value).trim();
      if (!/^https?:\/\//i.test(url)) {
        errors.push('resume_url must start with http:// or https://');
        continue;
      }
      lead[field] = url;
    } else {
      lead[field] = String(value).trim();
    }
  }

  if (!isBlank(lead.screening_status)) {
    const status = normalizeKey(lead.screening_status);
    if (!SCREENING_STATUSES.includes(status)) {
      errors.push(`screening_status must be one of: ${SCREENING_STATUSES.join(', ')}`);
    } else {
      lead.screening_status = status;
    }
  }

  return errors;
}

/**
 * Candidate columns to write on a leads insert. screening_status is always set because
 * batch upserts send the same column list for every row and the column is NOT NULL.
 * @param {object} lead A lead that already went through validateLead
 * @returns {object}
 */
export function candidateColumns(lead) {
  const cols = {};
  for (const field of CANDIDATE_FIELDS) cols[field] = lead[field] ?? null;
  cols.screening_status = lead.screening_status || 'pending';
  return cols;
}

/**
 * Cleans phone number by removing spaces, dashes, parentheses, dots, and formatting quirks.
 * Normalizes Indian mobile numbers (e.g. leading 0, 91, +91) into a clean 10-digit or +91 standard format.
 * @param {string|number} phone
 * @returns {string}
 */
export function cleanPhone(phone) {
  if (phone == null) return '';
  let str = String(phone).trim();
  if (!str) return '';

  // Handle scientific notation (e.g. 9.1987654321e11 or 9876543210e0)
  if (/^[0-9.]+e\+[0-9]+$/i.test(str)) {
    try {
      const num = Number(str);
      if (!isNaN(num)) {
        str = BigInt(Math.round(num)).toString();
      }
    } catch (e) {}
  }

  // Keep digits and leading plus sign
  let cleaned = str.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) {
    cleaned = '+' + cleaned.substring(1).replace(/\+/g, '');
  } else {
    cleaned = cleaned.replace(/\+/g, '');
  }

  // Digits-only check
  const digits = cleaned.replace(/\D/g, '');

  // 12 digits starting with 91 (e.g. 919876543210 -> +919876543210 or 9876543210)
  // If originally had +, preserve +91. Otherwise normalize 11-digit leading 0 to 10 digits
  if (digits.length === 11 && digits.startsWith('0')) {
    return digits.slice(1);
  }

  return cleaned;
}

/**
 * Validates the scoring weights configuration.
 * Weights must sum to 1.0 ± 0.001 and none can be negative.
 * @param {object} weights
 * @returns {object} { isValid: boolean, errors: string[] }
 */
export function validateScoringWeights(weights) {
  const errors = [];

  if (!weights || typeof weights !== 'object' || Array.isArray(weights)) {
    return { isValid: false, errors: ['Weights configuration must be an object'] };
  }

  const keys = Object.keys(weights);
  if (keys.length === 0) {
    return { isValid: false, errors: ['Weights configuration cannot be empty'] };
  }

  let sum = 0;
  for (const key of keys) {
    const val = weights[key];
    if (val === undefined || val === null) {
      errors.push(`Weight field '${key}' is required`);
    } else if (typeof val !== 'number' || isNaN(val)) {
      errors.push(`Weight field '${key}' must be a valid number`);
    } else if (val < 0 || val > 1) {
      errors.push(`Weight field '${key}' must be between 0 and 1`);
    } else {
      sum += val;
    }
  }

  if (errors.length > 0) {
    return { isValid: false, errors };
  }

  // Verify weights sum to 1.0 +/- 0.001
  if (Math.abs(sum - 1.0) > 0.001) {
    errors.push(`Scoring weights must sum to 1.0 (got ${sum.toFixed(4)})`);
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Validates conversational script schema during creation.
 * @param {object} script The script object.
 * @returns {object} { isValid: boolean, errors: string[] }
 */
export function validateScript(script) {
  const errors = [];
  if (!script || typeof script !== 'object') {
    return { isValid: false, errors: ['Script must be a JSON object'] };
  }

  if (!script.tenant_id || typeof script.tenant_id !== 'string' || script.tenant_id.trim() === '') {
    errors.push('tenant_id is required');
  }

  if (!script.script_id || typeof script.script_id !== 'string' || script.script_id.trim() === '') {
    errors.push('script_id is required');
  }

  if (!script.version || typeof script.version !== 'string' || script.version.trim() === '') {
    errors.push('version is required');
  }

  if (!script.language || typeof script.language !== 'string') {
    errors.push('language must be a string');
  }

  if (!script.nodes || !Array.isArray(script.nodes) || script.nodes.length === 0) {
    errors.push('nodes must be a non-empty array');
  } else {
    const nodeIds = new Set(script.nodes.map(n => n.id).filter(id => typeof id === 'string'));
    script.nodes.forEach((node, index) => {
      if (!node.id || typeof node.id !== 'string' || node.id.trim() === '') {
        errors.push(`Node [index ${index}] lacks a valid string id`);
      }
      if (!node.prompt || typeof node.prompt !== 'string') {
        errors.push(`Node "${node.id || index}" prompt must be a string`);
      }
      if (node.expected_intents && !Array.isArray(node.expected_intents)) {
        errors.push(`Node "${node.id || index}" expected_intents must be an array`);
      }
      if (node.branches && (typeof node.branches !== 'object' || Array.isArray(node.branches))) {
        errors.push(`Node "${node.id || index}" branches must be an object`);
      } else if (node.branches) {
        Object.entries(node.branches).forEach(([intent, targetId]) => {
          if (!nodeIds.has(targetId)) {
            errors.push(`Node "${node.id}" branches to non-existent node "${targetId}"`);
          }
        });
      }
    });
  }

  if (script.escalation_triggers !== undefined) {
    if (!Array.isArray(script.escalation_triggers)) {
      errors.push('escalation_triggers must be an array');
    } else {
      const allowedTypes = ['explicit_request', 'sentiment_low', 'high_intent', 'max_duration'];
      script.escalation_triggers.forEach((trigger, idx) => {
        if (!trigger.type || !allowedTypes.includes(trigger.type)) {
          errors.push(`Escalation trigger [index ${idx}] has invalid type: ${trigger.type || 'none'}`);
        }
        if (trigger.type === 'explicit_request' || trigger.type === 'high_intent') {
          if (!trigger.phrases || !Array.isArray(trigger.phrases)) {
            errors.push(`Escalation trigger [index ${idx}] of type "${trigger.type}" must have a phrases array`);
          }
        }
        if (trigger.type === 'sentiment_low' && typeof trigger.threshold !== 'number') {
          errors.push(`Escalation trigger [index ${idx}] of type "sentiment_low" must have a numeric threshold`);
        }
        if (trigger.type === 'max_duration' && typeof trigger.seconds !== 'number') {
          errors.push(`Escalation trigger [index ${idx}] of type "max_duration" must have a numeric seconds field`);
        }
      });
    }
  }

  if (script.max_duration_seconds !== undefined && typeof script.max_duration_seconds !== 'number') {
    errors.push('max_duration_seconds must be a number');
  }

  return { isValid: errors.length === 0, errors };
}

