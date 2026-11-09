import db from '../config/db.js';
import { MAX_CANDIDATES_PER_BATCH } from '../utils/validation.js';

/**
 * ─── Workspace limits ───────────────────────────────────────────────────────
 * A workspace made through the sign-up link is a demo: it can try everything, but within limits,
 * because its calls spend the app's speech and LLM credits and its invites go out from the app's
 * mailbox. The main workspace has no limits (its limit columns are NULL).
 */

export const DEMO_LIMITS = Object.freeze({
  max_campaigns: 3,
  max_candidates_per_campaign: 10,
  max_completed_calls: 25,
  max_members: 5,
  max_emails_per_day: 30
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** A limit was reached; the message says which one. */
export class LimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LimitError';
    this.status = 409;
  }
}

const limitOf = (workspace, key) => (Number.isInteger(workspace?.[key]) ? workspace[key] : null);

/** Refuses a new campaign when the workspace already has its maximum. */
export async function checkCampaignLimit(workspaceId) {
  const max = limitOf(await db.getWorkspace(workspaceId), 'max_campaigns');
  if (max !== null && (await db.countBatchesInWorkspace(workspaceId)) >= max) {
    throw new LimitError(`This demo workspace can have ${max} campaigns. Delete one to create another.`);
  }
}

/** How many candidates one campaign may hold in this workspace. */
export async function candidateLimit(workspaceId) {
  const max = limitOf(await db.getWorkspace(workspaceId), 'max_candidates_per_campaign');
  return max === null ? MAX_CANDIDATES_PER_BATCH : Math.min(max, MAX_CANDIDATES_PER_BATCH);
}

/** Refuses a new team member when the workspace is full. */
export async function checkMemberLimit(workspaceId) {
  const max = limitOf(await db.getWorkspace(workspaceId), 'max_members');
  if (max !== null && (await db.countMembers(workspaceId)) >= max) {
    throw new LimitError(`This demo workspace can have ${max} team members.`);
  }
}

/** Refuses to start a call when the workspace has used its completed calls. */
export async function checkCallLimit(workspaceId) {
  if (!workspaceId) return;
  const max = limitOf(await db.getWorkspace(workspaceId), 'max_completed_calls');
  if (max !== null && (await db.countCompletedCallsInWorkspace(workspaceId)) >= max) {
    throw new LimitError('This screening is closed: the workspace has used all its demo calls. Please contact the HR team.');
  }
}

// One email at a time per limited workspace, so two parallel senders cannot both pass the check.
const emailLocks = new Map();

/**
 * Runs `send` only if the workspace is still under its daily email limit (last 24 hours).
 * Workspaces without a limit send straight away.
 */
export async function withEmailAllowance(workspaceId, send) {
  const max = workspaceId ? limitOf(await db.getWorkspace(workspaceId), 'max_emails_per_day') : null;
  if (max === null) return send();
  const previous = emailLocks.get(workspaceId) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const sent = await db.countInviteEmailsSince(workspaceId, new Date(Date.now() - DAY_MS).toISOString());
    if (sent >= max) throw new LimitError(`Daily limit reached: this demo workspace can send ${max} invite emails a day.`);
    return send();
  });
  emailLocks.set(workspaceId, run);
  try {
    return await run;
  } finally {
    if (emailLocks.get(workspaceId) === run) emailLocks.delete(workspaceId);
  }
}

/** The workspace's name, kind, limits and current usage, for the HR screens. */
export async function workspaceSummary(workspaceId) {
  const ws = await db.getWorkspace(workspaceId);
  if (!ws) return null;
  const limits = Object.fromEntries(Object.keys(DEMO_LIMITS).map(k => [k, limitOf(ws, k)]));
  const limited = Object.values(limits).some(v => v !== null);
  const usage = limited ? {
    campaigns: await db.countBatchesInWorkspace(workspaceId),
    members: await db.countMembers(workspaceId),
    completed_calls: await db.countCompletedCallsInWorkspace(workspaceId),
    emails_last_24h: await db.countInviteEmailsSince(workspaceId, new Date(Date.now() - DAY_MS).toISOString())
  } : null;
  return { id: ws.id, name: ws.name, kind: ws.kind, limits: limited ? limits : null, usage };
}
