import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAnalytics } from '../../backend/src/services/analytics.js';
import { rowsFromTable, parseCsvTable, cellText } from '../../backend/src/services/spreadsheet.js';
import { canManage } from '../../backend/src/routes/hr.js';

const NOW = Date.parse('2026-11-05T12:00:00Z');

test('analytics: totals, completion rate, averages, funnel', () => {
  const batches = [{ id: 'b1', name: 'Live', status: 'live' }, { id: 'b2', name: 'Draft', status: 'draft' }];
  const candidates = [
    { id: 'c1', batch_id: 'b1', name: 'Asha', status: 'completed' },
    { id: 'c2', batch_id: 'b1', name: 'Ravi', status: 'failed' },
    { id: 'c3', batch_id: 'b1', name: 'Neha', status: 'resume_uploaded' },
    { id: 'c4', batch_id: 'b2', name: 'Kiran', status: 'invited' }
  ];
  const calls = [
    { id: 'k1', candidate_id: 'c1', status: 'completed', fit_score: 80, started_at: '2026-11-05T10:00:00Z', ended_at: '2026-11-05T10:05:00Z' },
    { id: 'k2', candidate_id: 'c2', status: 'failed', fit_score: null, started_at: '2026-11-04T09:00:00Z', ended_at: '2026-11-04T09:01:00Z' }
  ];
  const a = computeAnalytics({ batches, candidates, calls, now: NOW });
  assert.deepEqual(a.campaigns, { total: 2, draft: 1, live: 1, closed: 0 });
  assert.equal(a.candidates.total, 4);
  // 1 completed out of the 3 candidates in the running campaign.
  assert.equal(a.completion_rate, 33);
  assert.equal(a.avg_fit_score, 80);
  assert.equal(a.avg_call_seconds, 300);
  assert.deepEqual(a.funnel.map(f => f.count), [4, 3, 3, 2, 1]);
  assert.equal(a.score_distribution[4].count, 1);
  assert.equal(a.top_candidates[0].name, 'Asha');
  assert.equal(a.recent_calls[0].call_id, 'k1');
});

test('analytics: calls per Indian calendar day over the last 14 days', () => {
  const calls = [
    // 20:00 UTC on 4 Nov is 01:30 IST on 5 Nov.
    { id: 'k1', candidate_id: 'c1', status: 'completed', started_at: '2026-11-04T19:55:00Z', ended_at: '2026-11-04T20:00:00Z' },
    { id: 'k2', candidate_id: 'c1', status: 'in_progress', started_at: '2026-11-05T09:00:00Z', ended_at: null }
  ];
  const a = computeAnalytics({ batches: [], candidates: [], calls, now: NOW });
  assert.equal(a.per_day.length, 14);
  assert.equal(a.per_day[13].day, '2026-11-05');
  assert.equal(a.per_day[13].completed, 1);
  assert.equal(a.per_day[0].day, '2026-10-23');
});

test('analytics: empty account gives zeros and nulls, not errors', () => {
  const a = computeAnalytics({ batches: [], candidates: [], calls: [], now: NOW });
  assert.deepEqual([a.completion_rate, a.avg_fit_score, a.avg_call_seconds, a.top_candidates.length], [null, null, null, 0]);
});

test('spreadsheet: header row in any order and case', () => {
  const r = rowsFromTable([['Email', 'Phone', 'Full Name'], ['ASHA@X.COM', '1', 'Asha Rao'], ['', '', '']]);
  assert.deepEqual(r.rows, [{ name: 'Asha Rao', email: 'asha@x.com' }]);
  assert.deepEqual(r.columns, { name: 2, email: 0 });
});

test('spreadsheet: no header row, email column found by content', () => {
  const r = rowsFromTable([['Asha Rao', 'asha@x.com'], ['Ravi', 'ravi@x.com']]);
  assert.equal(r.header, false);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[1].email, 'ravi@x.com');
});

test('spreadsheet: no emails anywhere is a clear error', () => {
  assert.match(rowsFromTable([['a', 'b'], ['c', 'd']]).error, /No email column/);
  assert.match(rowsFromTable([]).error, /no rows/);
});

test('spreadsheet: CSV with quotes, semicolons and BOM; Excel cell shapes', () => {
  assert.deepEqual(parseCsvTable('﻿Name;Email\r\n"Rao, Asha";a@x.com\r\n'), [['Name', 'Email'], ['Rao, Asha', 'a@x.com']]);
  assert.equal(cellText({ richText: [{ text: 'As' }, { text: 'ha' }] }), 'Asha');
  assert.equal(cellText({ text: 'a@x.com', hyperlink: 'mailto:a@x.com' }), 'a@x.com');
  assert.equal(cellText({ formula: 'A1', result: 'x@y.z' }), 'x@y.z');
});

test('RBAC: inside a workspace an Admin or HR lead manages every campaign, a recruiter only their own', () => {
  const batch = { id: 'b1', created_by: 'r1', workspace_id: 'ws-1' };
  assert.equal(canManage({ id: 'a1', role: 'superadmin', workspace_id: 'ws-1' }, batch), true);
  assert.equal(canManage({ id: 'l1', role: 'hr_lead', workspace_id: 'ws-1' }, batch), true);
  assert.equal(canManage({ id: 'r1', role: 'recruiter', workspace_id: 'ws-1' }, batch), true);
  assert.equal(canManage({ id: 'r2', role: 'recruiter', workspace_id: 'ws-1' }, batch), false);
  assert.equal(canManage({ id: 'r1', role: 'recruiter', workspace_id: 'ws-1' }, null), false);
});

test('RBAC: nobody reaches another workspace, not even its Admin or the creator', () => {
  const batch = { id: 'b1', created_by: 'r1', workspace_id: 'ws-1' };
  assert.equal(canManage({ id: 'a2', role: 'superadmin', workspace_id: 'ws-2' }, batch), false);
  assert.equal(canManage({ id: 'l2', role: 'hr_lead', workspace_id: 'ws-2' }, batch), false);
  assert.equal(canManage({ id: 'r1', role: 'recruiter', workspace_id: 'ws-2' }, batch), false, 'moved to another workspace');
  assert.equal(canManage({ id: 'a1', role: 'superadmin', workspace_id: null }, batch), false, 'no workspace, no access');
  assert.equal(canManage({ id: 'a1', role: 'superadmin', workspace_id: 'ws-1' }, { id: 'b2', created_by: 'x' }), false, 'a campaign without a workspace');
});
