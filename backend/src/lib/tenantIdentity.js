export function generateTenantTag() {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  for (let i = 0; i < 8; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

export function resolveAgentName(baseName, tenantTag) {
  if (!baseName || !tenantTag) throw new Error("baseName and tenantTag are required");
  return `${baseName}_TAG${tenantTag}`;
}

export function parseAgentName(fullName) {
  if (!fullName) return null;
  const match = fullName.match(/^(.*)_TAG([a-z0-9]{6,16})$/);
  if (!match) return null;
  return {
    baseName: match[1],
    tenantTag: match[2]
  };
}

export function validateAgentBelongsToTenant(agentName, tenantTag) {
  if (!agentName || !tenantTag) return false;
  const parsed = parseAgentName(agentName);
  if (!parsed) return false;
  return parsed.tenantTag === tenantTag;
}

export function isTaggedAgent(agentName) {
  return parseAgentName(agentName) !== null;
}
