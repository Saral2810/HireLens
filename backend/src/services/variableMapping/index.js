import db from '../../config/db.js';

const ALIAS_DICT = {
  name: ['name', 'first_name', 'full_name', 'customer_name', 'borrower_name', 'lead_name',
         'borrower_full_name', 'client_name', 'party_name', 'customer_full_name',
         'applicant_name', 'contact_name'],
  phone: ['phone', 'phone_number', 'mobile', 'contact_number', 'customer_phone', 'mobile_number'],
  amount: ['approved_amount', 'offer_amount', 'loan_amount', 'pre_approved_amt', 'sanctioned_amount', 'principal', 'amount'],
  rate: ['interest_rate', 'roi', 'roi_pct', 'rate', 'interest'],
  fee: ['processing_fee', 'fee', 'charges'],
  email: ['email', 'email_id', 'contact_email']
};


function legacyFallbackVariables(lead) {
  const raw = lead.raw_data || {};
  const amount = lead.offer_amount || raw.pre_approved_amt || raw.loan_amount || raw.sanctioned_amount || raw.approved_amount || raw.amount || null;
  const rate = raw.roi || lead.roi_pct || raw.interest_rate || raw.rate || null;
  const fee = raw.processing_fee || null;

  const base = {
    customer_name: (lead.name && lead.name.trim()) || 'Customer',
    first_name: (lead.name || 'Customer').split(' ')[0],
    mobile_number: lead.phone || raw.mobile_number || raw.phone || '',
    ...raw
  };

  if (amount !== null && amount !== undefined) {
    base.approved_amount = amount;
    if (base.offer_amount === undefined) base.offer_amount = amount;
    if (base.loan_amount === undefined) base.loan_amount = amount;
    if (base.pre_approved_amt === undefined) base.pre_approved_amt = amount;
  }

  if (rate !== null && rate !== undefined) {
    base.interest_rate = rate;
    if (base.roi === undefined) base.roi = rate;
  }

  if (fee !== null && fee !== undefined) {
    base.processing_fee = fee;
  }

  const internalKeys = ['transcript_json', 'analysis', 'sentiment', 'attempts', 'queue_id', 'provisional_call_id', 'voice_agent_id', 'source_row_id', 'source_table'];
  for (const k of internalKeys) {
    delete base[k];
  }
  return base;
}

const HINDI_0_TO_99 = {
  0: 'शून्य', 1: 'एक', 2: 'दो', 3: 'तीन', 4: 'चार', 5: 'पाँच', 6: 'छह', 7: 'सात', 8: 'आठ', 9: 'नौ',
  10: 'दस', 11: 'ग्यारह', 12: 'बारह', 13: 'तेरह', 14: 'चौदह', 15: 'पंद्रह', 16: 'सोलह', 17: 'सत्रह', 18: 'अठारह', 19: 'उन्नीस',
  20: 'बीस', 21: 'इक्कीस', 22: 'बाईस', 23: 'तेईस', 24: 'चौबीस', 25: 'पच्चीस', 26: 'छब्बीस', 27: 'सत्ताईस', 28: 'अट्ठाईस', 29: 'उनतीस',
  30: 'तीस', 31: 'इकतीस', 32: 'बत्तीस', 33: 'तैंतीस', 34: 'चौंतीस', 35: 'पैंतीस', 36: 'छत्तीस', 37: 'सैंतीस', 38: 'अड़तीस', 39: 'उनतालीस',
  40: 'चालीस', 41: 'इकतालीस', 42: 'बयालीस', 43: 'तैंतालीस', 44: 'चौवालीस', 45: 'पैंतालीस', 46: 'छियालीस', 47: 'सैंतालीस', 48: 'अड़तालीस', 49: 'उनचास',
  50: 'पचास', 51: 'इक्यावन', 52: 'बावन', 53: 'तिरेपन', 54: 'चौवन', 55: 'पचपन', 56: 'छप्पन', 57: 'सत्तावन', 58: 'अट्ठावन', 59: 'उनसठ',
  60: 'साठ', 61: 'इकसठ', 62: 'बासठ', 63: 'तिरसठ', 64: 'चौंसठ', 65: 'पैंसठ', 66: 'छियासठ', 67: 'सड़सठ', 68: 'अड़सठ', 69: 'उनहत्तर',
  70: 'सत्तर', 71: 'इकहत्तर', 72: 'बहत्तर', 73: 'तिहत्तर', 74: 'चौहत्तर', 75: 'पचहत्तर', 76: 'छिहत्तर', 77: 'सतहत्तर', 78: 'अठहत्तर', 79: 'उन्यासी',
  80: 'अस्सी', 81: 'इक्यासी', 82: 'बयासी', 83: 'तिरासी', 84: 'चौरासी', 85: 'पचासी', 86: 'छियासी', 87: 'सत्तासी', 88: 'अट्ठासी', 89: 'नवासी',
  90: 'नब्बे', 91: 'इक्यानवे', 92: 'बानवे', 93: 'तिरानवे', 94: 'चौरानवे', 95: 'पचानवे', 96: 'छियानवे', 97: 'सत्तानवे', 98: 'अट्ठानवे', 99: 'निन्यानवे'
};

export function inr_hindi_words(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return "";
  if (String(n).trim() === '') return "";
  const num = Math.round(Number(n));
  if (num === 0) return 'शून्य';
  
  const crore = Math.floor(num / 10000000);
  const lakh = Math.floor((num % 10000000) / 100000);
  const thousand = Math.floor((num % 100000) / 1000);
  const hundred = Math.floor((num % 1000) / 100);
  const remainder = num % 100;
  
  let result = [];
  
  if (crore > 0) {
    result.push((crore > 99 ? inr_hindi_words(crore) : HINDI_0_TO_99[crore]) + ' करोड़');
  }
  if (lakh > 0) {
    result.push((lakh > 99 ? inr_hindi_words(lakh) : HINDI_0_TO_99[lakh]) + ' लाख');
  }
  if (thousand > 0) {
    result.push((thousand > 99 ? inr_hindi_words(thousand) : HINDI_0_TO_99[thousand]) + ' हज़ार');
  }
  if (hundred > 0) {
    result.push((hundred > 99 ? inr_hindi_words(hundred) : HINDI_0_TO_99[hundred]) + ' सौ');
  }
  if (remainder > 0) {
    result.push(remainder > 99 ? inr_hindi_words(remainder) : HINDI_0_TO_99[remainder]);
  }
  
  return result.join(' ').replace(/\s+/g, ' ').trim();
}

export function inr_hindi_words_rupees(n) {
  const base = inr_hindi_words(n);
  return base ? base + ' रुपये' : "";
}

export function hindi_decimal_words(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return "";
  if (String(n).trim() === '') return "";
  const rounded = Math.round(Number(n) * 100) / 100;
  const parts = String(rounded).split('.');
  const intPart = parseInt(parts[0], 10);
  
  let result = inr_hindi_words(intPart);
  
  if (parts[1]) {
    result += " दशमलव";
    for (const char of parts[1]) {
      result += " " + HINDI_0_TO_99[parseInt(char, 10)];
    }
  }
  
  return result;
}

export async function resolveAgentVariables(tenantId, providerType, agentId, lead, campaign) {
  
  const base = legacyFallbackVariables(lead);
  const resolved = { ...base };

  if (!db.supabase) {
    console.warn('[VarMap] No DB connection — using legacy fallback variables only');
    return resolved;
  }


  let { data: mappings, error } = await db.supabase
    .from('agent_variable_mappings')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('provider_type', providerType)
    .eq('agent_id', agentId);
    
  if (error) {
    if (error.code === 'PGRST205') return resolved;
    throw error;
  }
  
  if (!mappings || mappings.length === 0) {
    const { data: fallbackMappings, error: fallbackErr } = await db.supabase
      .from('agent_variable_mappings')
      .select('*')
      .eq('tenant_id', tenantId)
      .eq('provider_type', providerType)
      .eq('agent_id', '*');
      
    if (fallbackErr) {
      if (fallbackErr.code === 'PGRST205') return resolved;
      throw fallbackErr;
    }
    mappings = fallbackMappings || [];
  }
  
  for (const mapping of mappings) {
    let rawValue = null;
    const expr = mapping.source_expression.trim();
    
    if (expr.startsWith("'") && expr.endsWith("'")) {
      rawValue = expr.slice(1, -1);
    } else if (!isNaN(Number(expr))) {
      rawValue = Number(expr);
    } else {
      const parts = expr.split('||').map(p => p.trim());
      for (const part of parts) {
        if (part.startsWith("'") && part.endsWith("'")) {
          rawValue = part.slice(1, -1);
          break;
        }
        if (!isNaN(Number(part))) {
          rawValue = Number(part);
          break;
        }
        const pathSegments = part.split('.');
        const root = pathSegments[0];
        let contextObj = null;
        
        if (root === 'leads') contextObj = lead;
        else if (root === 'campaigns') contextObj = campaign;
        
        if (contextObj) {
          let val = contextObj;
          for (let i = 1; i < pathSegments.length; i++) {
            if (val === undefined || val === null) break;
            val = val[pathSegments[i]];
          }
          if (val !== undefined && val !== null) {
            rawValue = val;
            break;
          }
        }
      }
    }
    
    if (rawValue === null || rawValue === undefined) {
      if (mapping.is_required) {
        console.warn(`[VarMap] Missing required variable ${mapping.target_variable} for agent ${agentId} (tenant ${tenantId})`);
      }
      continue;
    }
    
    let transformed = rawValue;
    switch (mapping.transform) {
      case 'inr_hindi_words':
        transformed = inr_hindi_words(rawValue);
        break;
      case 'inr_hindi_words_rupees':
        transformed = inr_hindi_words_rupees(rawValue);
        break;
      case 'hindi_decimal_words':
        transformed = hindi_decimal_words(rawValue);
        break;
      case 'phone_10digit':
        const cleaned = String(rawValue).replace(/[^\d]/g, '');
        transformed = cleaned.slice(-10);
        break;
      case 'phone_e164_in':
        let numStr = String(rawValue).replace(/[^\d]/g, '');
        if (numStr.length === 10) numStr = '91' + numStr;
        if (!numStr.startsWith('+')) numStr = '+' + numStr;
        transformed = numStr;
        break;
      case 'inr_integer':
        transformed = Math.round(Number(rawValue) || 0);
        break;
      case 'uppercase':
        transformed = String(rawValue).toUpperCase();
        break;
      case 'lowercase':
        transformed = String(rawValue).toLowerCase();
        break;
      case 'null_if_empty':
        if (String(rawValue).trim() === '') transformed = null;
        break;
    }
    
    if (transformed !== null) {
      resolved[mapping.target_variable] = transformed;
    } else if (mapping.is_required) {
      console.warn(`[VarMap] Missing required variable ${mapping.target_variable} after transform for agent ${agentId} (tenant ${tenantId})`);
    }
  }
  
  return resolved; // fail-safe partial map
}

export async function autoSuggestMappings(tenantId, providerType, agentId, sampleLead) {
  const suggestions = [];
  // For each alias category
  const categories = Object.keys(ALIAS_DICT);
  
  const leadFields = Object.keys(sampleLead).map(k => ({ path: `leads.${k}`, key: k }));
  const rawFields = sampleLead.raw_data ? Object.keys(sampleLead.raw_data).map(k => ({ path: `leads.raw_data.${k}`, key: k })) : [];
  const allFields = [...leadFields, ...rawFields];

  // The function is meant to map expected variables to source fields.
  // Wait, autoSuggest returns array of { target_variable, suggested_source, confidence, alternatives }
  // but it doesn't know the target_variables unless we pass expected variables!
  // Wait, the signature in prompt: `async autoSuggestMappings(tenantId, providerType, agentId, sampleLead)`
  // And it will call getAgentExpectedVariables inside it!
  const factory = await import('../voiceProvider/index.js');
  const provider = factory.getProvider(tenantId, providerType);
  const expectedVars = await provider.getAgentExpectedVariables(agentId);

  for (const expVar of expectedVars) {
    const target = expVar.name;
    const alternatives = [];
    
    // Direct matching
    for (const field of allFields) {
      const fieldKeyLower = field.key.toLowerCase();
      const targetLower = target.toLowerCase();
      
      if (fieldKeyLower === targetLower) {
        alternatives.push({ source: field.path, confidence: 1.0 });
      } else {
        // Alias match
        let isAlias = false;
        for (const cat of categories) {
          if (ALIAS_DICT[cat].includes(targetLower) && ALIAS_DICT[cat].includes(fieldKeyLower)) {
            isAlias = true;
            break;
          }
        }
        if (isAlias) {
          alternatives.push({ source: field.path, confidence: 0.8 });
        } else if (targetLower.includes(fieldKeyLower) || fieldKeyLower.includes(targetLower)) {
          // Partial substring
          alternatives.push({ source: field.path, confidence: 0.5 });
        }
      }
    }
    
    alternatives.sort((a, b) => b.confidence - a.confidence);
    if (alternatives.length > 0) {
      suggestions.push({
        target_variable: target,
        suggested_source: alternatives[0].source,
        confidence: alternatives[0].confidence,
        alternatives: alternatives.slice(1).map(a => a.source)
      });
    }
  }

  return suggestions;
}
