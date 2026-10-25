/**
 * ─── Dashboard analytics ────────────────────────────────────────────────────
 * Numbers for the HR dashboard, computed from campaigns, candidates and calls the user can see.
 * Pure function: no database, no network.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
// Calls are counted by Indian calendar day.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const istDay = (iso) => new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 10);

export const SCORE_BUCKETS = ['0–19', '20–39', '40–59', '60–79', '80–100'];

/**
 * @param {{ batches: object[], candidates: object[], calls: object[], now?: number, days?: number }} input
 *   calls: every call of these candidates (any status)
 */
export function computeAnalytics({ batches, candidates, calls, now = Date.now(), days = 14 }) {
  const batchById = new Map(batches.map(b => [b.id, b]));
  const candById = new Map(candidates.map(c => [c.id, c]));
  const completed = calls.filter(c => c.status === 'completed');

  const campaigns = { total: batches.length, draft: 0, live: 0, closed: 0 };
  for (const b of batches) campaigns[b.status || 'draft'] += 1;

  const byStatus = { invited: 0, resume_uploaded: 0, in_call: 0, completed: 0, failed: 0 };
  for (const c of candidates) byStatus[c.status] = (byStatus[c.status] || 0) + 1;

  const scores = completed.map(c => c.fit_score).filter(s => typeof s === 'number');
  const durations = completed
    .filter(c => c.ended_at)
    .map(c => (Date.parse(c.ended_at) - Date.parse(c.started_at)) / 1000)
    .filter(s => s > 0);
  const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  // Candidates in campaigns that have been run (draft ones have not been offered a call yet).
  const offered = candidates.filter(c => batchById.get(c.batch_id)?.status !== 'draft');
  const startedIds = new Set(calls.map(c => c.candidate_id));

  const perDay = [];
  const today = istDay(new Date(now).toISOString());
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(Date.parse(`${today}T00:00:00Z`) - i * DAY_MS).toISOString().slice(0, 10);
    perDay.push({ day, completed: 0, failed: 0 });
  }
  const dayIndex = new Map(perDay.map((d, i) => [d.day, i]));
  for (const call of calls) {
    if (!call.ended_at || !['completed', 'failed'].includes(call.status)) continue;
    const i = dayIndex.get(istDay(call.ended_at));
    if (i !== undefined) perDay[i][call.status] += 1;
  }

  const distribution = SCORE_BUCKETS.map(label => ({ label, count: 0 }));
  for (const s of scores) distribution[Math.min(4, Math.floor(s / 20))].count += 1;

  const describe = (call) => {
    const cand = candById.get(call.candidate_id);
    const batch = cand && batchById.get(cand.batch_id);
    return {
      call_id: call.id, candidate_id: call.candidate_id, name: cand?.name || '—', campaign: batch?.name || '—',
      campaign_id: batch?.id || null, status: call.status, fit_score: call.fit_score ?? null, ended_at: call.ended_at || null
    };
  };

  return {
    campaigns,
    candidates: { total: candidates.length, by_status: byStatus },
    calls: {
      completed: completed.length,
      failed: calls.filter(c => c.status === 'failed').length,
      in_progress: calls.filter(c => c.status === 'in_progress').length
    },
    completion_rate: offered.length ? Math.round((offered.filter(c => c.status === 'completed').length / offered.length) * 100) : null,
    avg_fit_score: scores.length ? Math.round(avg(scores)) : null,
    avg_call_seconds: durations.length ? Math.round(avg(durations)) : null,
    funnel: [
      { stage: 'Added', count: candidates.length },
      { stage: 'Campaign running', count: offered.length },
      { stage: 'Resume uploaded', count: candidates.filter(c => c.status !== 'invited').length },
      { stage: 'Call started', count: candidates.filter(c => startedIds.has(c.id)).length },
      { stage: 'Completed', count: byStatus.completed }
    ],
    per_day: perDay,
    score_distribution: distribution,
    top_candidates: completed
      .filter(c => typeof c.fit_score === 'number')
      .sort((a, b) => b.fit_score - a.fit_score)
      .slice(0, 5)
      .map(describe),
    recent_calls: calls
      .filter(c => c.ended_at)
      .sort((a, b) => Date.parse(b.ended_at) - Date.parse(a.ended_at))
      .slice(0, 8)
      .map(describe)
  };
}
