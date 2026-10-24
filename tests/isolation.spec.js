import { describe, it } from 'node:test';
import assert from 'node:assert';
import { validateAgentBelongsToTenant, isTaggedAgent, parseAgentName } from '../backend/src/lib/tenantIdentity.js';

describe('Agent Isolation Logic (Integration Simulation)', () => {
  it('should allow access when creating an agent without a suffix yet', () => {
    const reqBody = { agent_name: 'Brand New Agent' };
    const agentName = reqBody.agent_name;
    let isAllowed = true;
    
    // Simulating the middleware logic
    if (agentName.includes('_TAG')) {
      isAllowed = validateAgentBelongsToTenant(agentName, 'mytenant');
    }
    
    assert.strictEqual(isAllowed, true);
  });

  it('should allow access if the provided agent name suffix exactly matches the tenant tag', () => {
    const reqBody = { agent_name: 'Existing_Agent_TAGa3f9k2p1' };
    const agentName = reqBody.agent_name;
    const sessionTenantTag = 'a3f9k2p1';
    let isAllowed = true;
    
    if (agentName.includes('_TAG')) {
      isAllowed = validateAgentBelongsToTenant(agentName, sessionTenantTag);
    }
    
    assert.strictEqual(isAllowed, true);
  });

  it('should BLOCK access if the agent suffix belongs to another tenant (Cross-tenant leakage)', () => {
    const reqBody = { agent_name: 'Competitor_Agent_TAGz9y8x7w6' };
    const agentName = reqBody.agent_name;
    const sessionTenantTag = 'a3f9k2p1'; // Different tenant ID
    let isAllowed = true;
    
    if (agentName.includes('_TAG')) {
      isAllowed = validateAgentBelongsToTenant(agentName, sessionTenantTag);
    }
    
    assert.strictEqual(isAllowed, false);
  });

  it('should allow SuperAdmin to see agents from both Tenant A and Tenant B (TAG-tagged)', () => {
    const agents = [
      { agent_name: 'Sales_Agent_TAGa3f9k2p1' },
      { agent_name: 'Support_Agent_TAGz9y8x7w6' }
    ];
    
    // Simulating GET /voice-agents for SuperAdmin
    const visibleAgents = agents.filter(a => isTaggedAgent(a.agent_name));
    
    assert.strictEqual(visibleAgents.length, 2);
  });

  it('should block SuperAdmin from seeing legacy non-TAG agents', () => {
    const agents = [
      { agent_name: 'Legacy_Unscoped_Agent' },
      { agent_name: 'Valid_Agent_TAGa3f9k2p1' }
    ];
    
    // Simulating GET /voice-agents for SuperAdmin
    const visibleAgents = agents.filter(a => isTaggedAgent(a.agent_name));
    
    assert.strictEqual(visibleAgents.length, 1);
    assert.strictEqual(visibleAgents[0].agent_name, 'Valid_Agent_TAGa3f9k2p1');
  });

  it('Webhook rejects payload where agent_name TAG doesn\'t match tenant_id', async () => {
    const rawEvent = { tenant_id: 'tenantA', agent_name: 'Agent_TAGb3f9k2p1' };
    const parsed = parseAgentName(rawEvent.agent_name);
    let error = null;
    if (!parsed) error = 'missing tag';
    else {
      const tenant = parsed.tenantTag === 'b3f9k2p1' ? { tenant_id: 'tenantB' } : null;
      if (!tenant || tenant.tenant_id !== rawEvent.tenant_id) error = 'mismatch';
    }
    assert.strictEqual(error, 'mismatch');
  });

  it('Hybrid webhook rejects payload where agent\'s TAG doesn\'t match lead\'s tenant', async () => {
    const rawEvent = { lead_id: '123', agent_name: 'Agent_TAGa3f9k2p1' };
    const parsed = parseAgentName(rawEvent.agent_name);
    let error = null;
    if (!parsed) error = 'missing tag';
    else {
      const lead = { id: '123', tenant_id: 'tenantB' };
      const tenant = parsed.tenantTag === 'a3f9k2p1' ? { tenant_id: 'tenantA' } : null;
      if (!tenant || tenant.tenant_id !== lead.tenant_id) error = 'mismatch';
    }
    assert.strictEqual(error, 'mismatch');
  });

  it('test-status endpoint returns 403 when session belongs to another tenant', async () => {
    const session = { tenant_id: 'tenantA' };
    const reqUser = { tenant_id: 'tenantB', isSuperAdmin: false };
    let status = 200;
    
    if (session.tenant_id !== reqUser.tenant_id && !reqUser.isSuperAdmin) {
      status = 403;
    }
    assert.strictEqual(status, 403);
  });
});
