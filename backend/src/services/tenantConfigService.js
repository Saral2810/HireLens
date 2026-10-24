/**
 * Tenant Configuration Service
 * Manages dynamically registered tenants and their specific routing, dialing, and AI logic profiles.
 */
import db from '../config/db.js';
import { generateTenantTag } from '../lib/tenantIdentity.js';

const defaultConfig = {
  tenant_id: 'default',
  name: 'Default Tenant',
  ingestion: {
    fieldMappings: {},
    customProcessor: null
  },
  queue: {
    prioritizeByExpiry: false,
    maxAttempts: 3,
    calling_hours: { start: 9, end: 21, timezone: 'Asia/Kolkata' } // India TRAI window: 09:00–21:00 IST
  },
  aiAgent: {
    persona: 'You are a helpful AI assistant.',
    disclosureRequired: false
  },
  crm: {
    dataMinimization: false,
    allowedSyncFields: [] // all
  }
};

class TenantConfigService {
  constructor() {
    // Seed initial tenants on startup if they don't exist
    this.initSeeds();
  }

  async initSeeds() {
    try {
      let existingDefault = await db.getTenantConfigById('default');
      if (!existingDefault || !existingDefault.aiAgent) {
        await db.upsertTenantConfig('default', defaultConfig);
      }
    } catch(e) {
      console.error('Failed to seed tenants in DB:', e);
    }
  }

  async getAllTenants() {
    try {
      const configs = await db.getAllTenantConfigs();
      return configs.map(config => ({
        id: config.tenant_id,
        ...defaultConfig,
        ...config,
        ingestion: { ...defaultConfig.ingestion, ...(config.ingestion || {}) },
        queue: { ...defaultConfig.queue, ...(config.queue || {}) },
        aiAgent: { ...defaultConfig.aiAgent, ...(config.aiAgent || {}) },
        crm: { ...defaultConfig.crm, ...(config.crm || {}) }
      }));
    } catch(e) {
      console.error('Failed to get all tenants:', e);
      return [defaultConfig];
    }
  }

  async getTenantsForUser(userId, isSuperAdmin) {
    try {
      const configs = await db.getTenantsForUser(userId, isSuperAdmin);
      return configs.map(config => ({
        id: config.tenant_id,
        ...defaultConfig,
        ...config,
        ingestion: { ...defaultConfig.ingestion, ...(config.ingestion || {}) },
        queue: { ...defaultConfig.queue, ...(config.queue || {}) },
        aiAgent: { ...defaultConfig.aiAgent, ...(config.aiAgent || {}) },
        crm: { ...defaultConfig.crm, ...(config.crm || {}) }
      }));
    } catch(e) {
      console.error('Failed to get tenants for user:', e);
      return [];
    }
  }

  async getTenantConfig(tenantId) {
    if (!tenantId) return defaultConfig;
    try {
      const config = await db.getTenantConfigById(tenantId);
      // If truly not found, return null so callers (like PUT /tenants/:id) can 404 correctly
      if (!config) return null;
      
      return {
        id: (config || defaultConfig).tenant_id,
        ...defaultConfig,
        ...config,
        ingestion: { ...defaultConfig.ingestion, ...(config.ingestion || {}) },
        queue: { ...defaultConfig.queue, ...(config.queue || {}) },
        aiAgent: { ...defaultConfig.aiAgent, ...(config.aiAgent || {}) },
        crm: { ...defaultConfig.crm, ...(config.crm || {}) }
      };
    } catch(e) {
      console.error('Failed to get tenant config for', tenantId, e);
      return null;
    }
  }

  async createTenant(config) {
    if (!config || !config.tenant_id) {
      throw new Error('tenant_id is required');
    }
    
    // Check for duplicate tenant_id
    const existing = await db.getTenantConfigById(config.tenant_id);
    if (existing) {
      throw new Error(`Tenant ID "${config.tenant_id}" already exists. Choose a different ID.`);
    }
    
    // Merge with defaults
    const newConfig = {
      tenant_id: config.tenant_id,
      tenant_tag: config.tenant_tag || generateTenantTag(),
      name: config.name || config.tenant_id,
      ingestion: { ...defaultConfig.ingestion, ...(config.ingestion || {}) },
      queue: { ...defaultConfig.queue, ...(config.queue || {}) },
      aiAgent: { ...defaultConfig.aiAgent, ...(config.aiAgent || {}) },
      crm: { ...defaultConfig.crm, ...(config.crm || {}) },
      enabled_features: config.enabled_features || null, // null = all features enabled
      status: 'active'
    };
    
    return await db.upsertTenantConfig(config.tenant_id, newConfig);
  }
  
  async updateTenant(tenantId, updates) {
    const existing = await this.getTenantConfig(tenantId);
    if (!existing) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    
    // Deep merge for nested config
    const merged = {
      ...existing,
      ...updates,
      ingestion: { ...(existing.ingestion || {}), ...(updates.ingestion || {}) },
      queue: { ...(existing.queue || {}), ...(updates.queue || {}) },
      aiAgent: { ...(existing.aiAgent || {}), ...(updates.aiAgent || {}) },
      crm: { ...(existing.crm || {}), ...(updates.crm || {}) },
      enabled_features: updates.enabled_features !== undefined ? updates.enabled_features : existing.enabled_features
    };
    
    return await db.upsertTenantConfig(tenantId, merged);
  }

  async deleteTenant(tenantId) {
    if (tenantId === 'default') throw new Error('Cannot delete the default tenant.');
    return await db.deleteTenantConfig(tenantId);
  }
}

export const tenantConfigService = new TenantConfigService();

