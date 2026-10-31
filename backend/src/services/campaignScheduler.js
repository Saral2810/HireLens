import db from '../config/db.js';
import { queueInviteEmails } from './candidateInvites.js';
import { prevoiceCampaign, prevoiceEnabled } from './prevoice.js';

/**
 * ─── Campaign scheduler ─────────────────────────────────────────────────────
 * HR can schedule a draft campaign to start at a set time (batches.scheduled_at): at that moment it
 * goes live and every candidate gets their invite email. A live campaign can also close itself at a
 * set time (batches.closes_at). The times live in the database, so a restart loses nothing; the
 * status-checked update means a campaign is started or closed once even with two servers running.
 *
 *   SCHEDULER_INTERVAL_MS  how often to check (default 60000)
 *   PUBLIC_APP_URL         the address put in invite emails (required for scheduled emails)
 */

export const MAX_SCHEDULE_DAYS = 180;

/** The app address for links in emails sent without an HR request (there is no Host header to use). */
function scheduledAppUrl() {
  return (process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
}

/**
 * Starts every due campaign and closes every expired one.
 * @param {{ now?: Date }} [opts]
 * @returns {Promise<{ started: string[], closed: string[], skipped: { id: string, reason: string }[], emails: Promise<unknown>[] }>}
 *   emails: the background email jobs (tests wait for them)
 */
export async function runDueSchedules({ now = new Date() } = {}) {
  const at = now.toISOString();
  const result = { started: [], closed: [], skipped: [], emails: [] };
  const { starting, closing } = await db.listDueSchedules(at);

  for (const due of starting) {
    const candidates = await db.listCandidates(due.id);
    if (!candidates.length) {
      // Nobody to invite: the schedule is dropped (the campaign stays a draft HR can fix and run).
      await db.updateBatchIfStatus(due.id, 'draft', { scheduled_at: null });
      result.skipped.push({ id: due.id, reason: 'no candidates' });
      console.warn(`[Scheduler] Campaign ${due.id} was due to start but has no candidates; schedule removed.`);
      continue;
    }
    const live = await db.updateBatchIfStatus(due.id, 'draft', { status: 'live', launched_at: at, closed_at: null, scheduled_at: null });
    if (!live) continue; // started or changed elsewhere in the meantime
    result.started.push(live.id);

    const base = scheduledAppUrl();
    if (base) {
      result.emails.push(queueInviteEmails(live, candidates, base).done);
    } else {
      console.warn(`[Scheduler] Campaign ${live.id} started, but PUBLIC_APP_URL is not set, so no invite emails were sent.`);
    }
    if (prevoiceEnabled()) {
      db.listQuestions(live.id).then(q => prevoiceCampaign(live, q)).catch(err => console.warn(`[Scheduler] Pre-voicing ${live.id} failed: ${err.message}`));
    }
  }

  for (const due of closing) {
    const closed = await db.updateBatchIfStatus(due.id, 'live', { status: 'closed', closed_at: at, closes_at: null });
    if (closed) result.closed.push(closed.id);
  }
  return result;
}

let timer = null;

/** Checks the schedule now and then every SCHEDULER_INTERVAL_MS. Safe to call once at server start. */
export function startScheduler() {
  if (timer || !db.isConfigured) return;
  const ms = Number(process.env.SCHEDULER_INTERVAL_MS) > 0 ? Number(process.env.SCHEDULER_INTERVAL_MS) : 60 * 1000;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await runDueSchedules();
      if (r.started.length || r.closed.length) console.log(`[Scheduler] Started ${r.started.length}, closed ${r.closed.length} campaign(s).`);
    } catch (err) {
      console.error('[Scheduler] Check failed:', err.message);
    } finally {
      running = false;
    }
  };
  tick();
  timer = setInterval(tick, ms);
  timer.unref();
}

export function stopScheduler() {
  clearInterval(timer);
  timer = null;
}

/**
 * Checks a schedule request. Draft campaigns get a start (and optional close) time; live ones only a close time.
 * @param {{ start_at?: unknown, close_at?: unknown }} body
 * @param {{ status: string }} batch
 * @returns {{ value: { scheduled_at?: string, closes_at?: string|null }, errors: string[] }}
 */
export function validateSchedule(body = {}, batch, now = new Date()) {
  const errors = [];
  const value = {};
  const parse = (v, label) => {
    if (typeof v !== 'string' || v.length > 40) { errors.push(`${label} must be a date and time.`); return null; }
    const t = Date.parse(v);
    if (!Number.isFinite(t)) { errors.push(`${label} must be a date and time.`); return null; }
    return new Date(t);
  };
  const latest = now.getTime() + MAX_SCHEDULE_DAYS * 24 * 3600 * 1000;

  if (batch.status === 'closed') return { value, errors: ['A closed campaign cannot be scheduled. Reopen it first.'] };
  let start = null;
  if (batch.status === 'draft') {
    start = parse(body.start_at, 'Start time');
    if (start && start.getTime() <= now.getTime()) errors.push('Start time must be in the future.');
    if (start && start.getTime() > latest) errors.push(`Start time must be within ${MAX_SCHEDULE_DAYS} days.`);
    if (start) value.scheduled_at = start.toISOString();
  } else if (body.start_at !== undefined && body.start_at !== null) {
    errors.push('This campaign is already running; only a close time can be set.');
  }

  if (body.close_at !== undefined && body.close_at !== null && body.close_at !== '') {
    const close = parse(body.close_at, 'Close time');
    const after = start || now;
    if (close && close.getTime() <= after.getTime()) errors.push(start ? 'Close time must be after the start time.' : 'Close time must be in the future.');
    if (close && close.getTime() > latest + 30 * 24 * 3600 * 1000) errors.push('Close time is too far away.');
    if (close) value.closes_at = close.toISOString();
  } else {
    value.closes_at = null;
  }
  return { value, errors };
}
