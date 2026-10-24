import { describe, it } from 'node:test';
import assert from 'node:assert';
import { generateTenantTag, resolveAgentName, parseAgentName, validateAgentBelongsToTenant } from '../backend/src/lib/tenantIdentity.js';

describe('tenantIdentity helper module', () => {
  it('should generate an 8-char short unique ID with safe characters', () => {
    const id = generateTenantTag();
    assert.strictEqual(id.length, 8);
    // Should not contain ambiguous chars: 0, 1, O, l
    assert.strictEqual(/[01Ol]/.test(id), false);
  });

  it('should correctly resolve an agent name with the TAG suffix', () => {
    const tenantTag = 'a3f9k2p1';
    const fullName = resolveAgentName('Ananya', tenantTag);
    assert.strictEqual(fullName, 'Ananya_TAGa3f9k2p1');
  });

  it('should correctly parse a valid TAG agent name (8-char and 9-char)', () => {
    const parsed8 = parseAgentName('Sales_Agent_TAGb4g7x9z2');
    assert.ok(parsed8);
    assert.strictEqual(parsed8.baseName, 'Sales_Agent');
    assert.strictEqual(parsed8.tenantTag, 'b4g7x9z2');

    const parsed9 = parseAgentName('Sales_Agent_TAGtagwiqyge');
    assert.ok(parsed9);
    assert.strictEqual(parsed9.baseName, 'Sales_Agent');
    assert.strictEqual(parsed9.tenantTag, 'tagwiqyge');
  });

  it('should return null when parsing an invalid agent name', () => {
    const parsed = parseAgentName('Sales_Agent_b4g7x9z2');
    assert.strictEqual(parsed, null);
  });

  it('should validate an agent correctly against a matching tenant tag (mixed lengths)', () => {
    assert.strictEqual(validateAgentBelongsToTenant('Lead_Gen_TAGx7y8z9w1', 'x7y8z9w1'), true);
    assert.strictEqual(validateAgentBelongsToTenant('Lead_Gen_TAGtagvbr5hm', 'tagvbr5hm'), true);
  });

  it('should reject validation if the tenant tag does not match the agent suffix', () => {
    const isValid = validateAgentBelongsToTenant('Lead_Gen_TAGx7y8z9w1', 'a1b2c3d4');
    assert.strictEqual(isValid, false);
  });
});
