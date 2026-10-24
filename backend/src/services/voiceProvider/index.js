import db from '../../config/db.js';
import { createClient } from '@supabase/supabase-js';
import { decrypt } from '../credentialCrypto.js';
import { GnaniProvider } from './gnaniProvider.js';
import { MockProvider } from './mockProvider.js';

/**
 * Registry of supported voice providers.
 * To add another provider: create <name>Provider.js extending base.js and register it here.
 */
const PROVIDERS = {
  gnani: GnaniProvider,
  mock: MockProvider
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDERS);

/** Build a provider directly from raw (unsaved) credentials — used by the admin "Test connection" button. */
export function createProviderFromCredentials(providerType, credentials = {}) {
  const ProviderClass = PROVIDERS[providerType];
  if (!ProviderClass) throw new Error(`Unsupported voice provider type: ${providerType}`);
  return new ProviderClass(credentials);
}

let supabase = null;
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

/**
 * Factory to get a configured VoiceProvider instance.
 * Loads the encrypted credentials from tenant_voice_providers table and instantiates the specific adapter.
 */
export async function getProvider(tenantId, providerType) {
  let credentials = {};
  const client = db.supabase || supabase;
  try {
    if (db.isMock || !client) {
      const mockRecord = (db.mockDb?.tenantVoiceProviders || []).find(
        p => p.tenant_id === tenantId && p.provider_type === providerType
      );
      if (mockRecord) {
        if (mockRecord.disabled_at) {
          throw new Error(`Provider ${providerType} is disabled for tenant ${tenantId}`);
        }
        if (mockRecord.encrypted_credentials) {
          credentials = decrypt(mockRecord.encrypted_credentials);
        }
      }
    } else {
      const { data, error } = await client
        .from('tenant_voice_providers')
        .select('encrypted_credentials, disabled_at')
        .eq('tenant_id', tenantId)
        .eq('provider_type', providerType)
        .maybeSingle();

      if (error) throw error;

      if (data && data.disabled_at) {
        throw new Error(`Provider ${providerType} is disabled for tenant ${tenantId}`);
      }

      if (data && data.encrypted_credentials) {
        credentials = decrypt(data.encrypted_credentials);
      }
    }
  } catch (err) {
    if (err.message && err.message.includes('is disabled for tenant')) {
      throw err;
    }
    console.error('[voiceProviderFactory] Error loading credentials:', err.message || err);
    // Fall back to empty credentials (which relies on env vars for Phase 1A backward compatibility)
  }

  const credsWithTenant = { ...credentials, tenant_id: tenantId };
  const type = providerType || process.env.DEFAULT_VOICE_PROVIDER || 'gnani';
  const ProviderClass = PROVIDERS[type];
  if (ProviderClass) {
    return new ProviderClass(credsWithTenant);
  }

  throw new Error(`Unsupported voice provider type: ${providerType}`);
}

export default { getProvider, createProviderFromCredentials, SUPPORTED_PROVIDERS };
