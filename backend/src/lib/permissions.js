export const ROLES = {
  OWNER: 'owner',
  ADMIN: 'admin',
  MEMBER: 'member'
};

export const PERMISSIONS = {
  // Tenant Settings
  'tenant:read': [ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER],
  'tenant:edit': [ROLES.OWNER, ROLES.ADMIN],
  'tenant:delete': [ROLES.OWNER],

  // Users (Provisioning)
  'users:read': [ROLES.OWNER, ROLES.ADMIN],
  'users:invite': [ROLES.OWNER, ROLES.ADMIN],
  'users:remove': [ROLES.OWNER, ROLES.ADMIN],
  'users:change_role': [ROLES.OWNER],

  // Leads
  'leads:read': [ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER],
  'leads:create': [ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER],
  'leads:edit': [ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER],
  'leads:delete': [ROLES.OWNER, ROLES.ADMIN],

  // Campaigns
  'campaigns:read': [ROLES.OWNER, ROLES.ADMIN, ROLES.MEMBER],
  'campaigns:create': [ROLES.OWNER, ROLES.ADMIN],
  'campaigns:edit': [ROLES.OWNER, ROLES.ADMIN],
  'campaigns:delete': [ROLES.OWNER, ROLES.ADMIN],

  // Billing / API Keys
  'billing:manage': [ROLES.OWNER],
  'apikeys:manage': [ROLES.OWNER, ROLES.ADMIN]
};

export function hasPermission(role, permission) {
  const allowedRoles = PERMISSIONS[permission];
  if (!allowedRoles) return false;
  return allowedRoles.includes(role);
}
