import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, BarChart3, ChevronRight, Download, RefreshCw, RotateCcw } from 'lucide-react';
import { api } from '../../services/api';
import { HrQuestion, ResultRow } from '../../types';
import { EmptyState, ErrorNote } from '../ui/Modal';
import { ScorePill, StatusBadge } from './StatusBadge';
import { CandidateResultDrawer } from './CandidateResultDrawer';

type SortKey = 'name' | 'status' | 'notice_period_days' | 'current_ctc_lpa' | 'expected_ctc_lpa' | 'fit_score';

const COLUMNS: { key: SortKey; label: string; numeric?: boolean }[] = [
  { key: 'name', label: 'Candidate' },
  { key: 'status', label: 'Status' },
  { key: 'fit_score', label: 'Fit', numeric: true },
  { key: 'notice_period_days', label: 'Notice', numeric: true },
  { key: 'current_ctc_lpa', label: 'Current CTC', numeric: true },
  { key: 'expected_ctc_lpa', label: 'Expected CTC', numeric: true }
];

const STATUS_ORDER = { completed: 0, failed: 1, in_call: 2, resume_uploaded: 3, invited: 4 };

function sortValue(row: ResultRow, key: SortKey): string | number | null {
  if (key === 'fit_score') return row.call?.fit_score ?? null;
  if (key === 'status') return STATUS_ORDER[row.status];
  if (key === 'name') return row.name.toLowerCase();
  return row[key];
}

export const days = (d: number | null) => (d === null ? '—' : d === 0 ? 'Immediate' : `${d} days`);
export const lpa = (v: number | null) => (v === null ? "—" : `${v} LPA`);

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** HR's own questions get a column each; notice period and CTC already have theirs. */
const customColumns = (questions: HrQuestion[]) => questions.filter(q => q.answer_type !== 'duration' && q.answer_type !== 'ctc');

/** A candidate's answer to one HR question, matched by wording (like the export). */
function answerFor(row: ResultRow, question: HrQuestion) {
  return row.answers.find(a => a.source === 'hr' && sameText(a.question_text, question.question_text))?.display || '—';
}

/** Results tab: one row per candidate with the key answers, sortable, with CSV/Excel export. */
export const ResultsTable: React.FC<{ batchId: string; onCandidatesChanged?: () => void }> = ({ batchId, onCandidatesChanged }) => {
  const [rows, setRows] = useState<ResultRow[] | null>(null);
  const [questions, setQuestions] = useState<HrQuestion[]>([]);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'fit_score', desc: true });
  const [openCallId, setOpenCallId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const results = await api.getResults(batchId);
      setRows(results.rows);
      setQuestions(customColumns(results.questions || []));
    } catch (err: any) { setError(err.message); }
  }, [batchId]);
  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    if (!rows) return [];
    return [...rows].sort((a, b) => {
      const x = sortValue(a, sort.key);
      const y = sortValue(b, sort.key);
      // Missing values always go last, whichever way the column is sorted.
      if (x === null && y === null) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      const cmp = x < y ? -1 : x > y ? 1 : 0;
      return sort.desc ? -cmp : cmp;
    });
  }, [rows, sort]);

  const exportAs = async (format: 'csv' | 'xlsx') => {
    setBusy(format);
    setError(null);
    try { await api.downloadResults(batchId, format); } catch (err: any) { setError(err.message); } finally { setBusy(null); }
  };

  const retake = async (row: ResultRow) => {
    if (!window.confirm(`Let ${row.name} take the call again? Their earlier answers stay saved; the results will show the new call.`)) return;
    setBusy(row.candidate_id);
    setError(null);
    try {
      await api.allowRetake(row.candidate_id);
      await load();
      onCandidatesChanged?.();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const completed = rows?.filter(r => r.status === 'completed') ?? [];
  const scores = completed.map(r => r.call?.fit_score).filter((s): s is number => typeof s === 'number');
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  return (
    <div className="stack">
      {rows && rows.length > 0 && (
        <div className="stat-row" style={{ marginBottom: 0 }}>
          <div className="stat"><div className="stat-value">{completed.length}<span className="muted" style={{ fontSize: 15 }}> / {rows.length}</span></div><div className="stat-label">Calls completed</div></div>
          <div className="stat"><div className="stat-value">{avg ?? '—'}</div><div className="stat-label">Average fit score</div></div>
          <div className="stat"><div className="stat-value">{scores.filter(s => s >= 70).length}</div><div className="stat-label">Strong fits (70+)</div></div>
          <div className="stat"><div className="stat-value">{rows.filter(r => r.status === 'failed').length}</div><div className="stat-label">Did not finish</div></div>
        </div>
      )}

      <div className="row-wrap">
        <p className="muted small grow">Click a candidate for their answers, transcript and recording.</p>
        <button className="btn btn-ghost" onClick={load} aria-label="Refresh results"><RefreshCw size={15} /> Refresh</button>
        <button className="btn" onClick={() => exportAs('csv')} disabled={!rows?.length || busy !== null}>
          <Download size={15} /> {busy === 'csv' ? 'Exporting…' : 'CSV'}
        </button>
        <button className="btn btn-primary" onClick={() => exportAs('xlsx')} disabled={!rows?.length || busy !== null}>
          <Download size={15} /> {busy === 'xlsx' ? 'Exporting…' : 'Excel'}
        </button>
      </div>
      <ErrorNote message={error} />

      {rows === null && !error && <p className="muted">Loading…</p>}

      {rows !== null && (
        <div className="card">
          {rows.length === 0 ? (
            <EmptyState icon={<BarChart3 size={20} />} title="No results yet">Results appear here as candidates finish their calls.</EmptyState>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    {COLUMNS.map(c => (
                      <th key={c.key} className={c.numeric && c.key !== 'fit_score' ? 'num' : undefined}
                        aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                        <button className="th-sort" onClick={() => setSort(s => ({ key: c.key, desc: s.key === c.key ? !s.desc : !!c.numeric }))}>
                          {c.label}
                          {sort.key === c.key && (sort.desc ? <ArrowDown size={12} /> : <ArrowUp size={12} />)}
                        </button>
                      </th>
                    ))}
                    {questions.map(q => (
                      <th key={q.id} title={q.question_text} style={{ minWidth: 140, maxWidth: 220 }}><span className="clamp-2">{q.question_text}</span></th>
                    ))}
                    <th>Summary</th>
                    <th className="actions"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map(r => (
                    <tr key={r.candidate_id} onClick={() => r.call && setOpenCallId(r.call.id)} style={{ cursor: r.call ? 'pointer' : 'default' }}>
                      <td>
                        <div className="strong">{r.name}</div>
                        <div className="tiny muted">{r.email}</div>
                      </td>
                      <td><StatusBadge status={r.status} /></td>
                      <td><ScorePill score={r.call?.fit_score} /></td>
                      <td className="num nowrap">{days(r.notice_period_days)}</td>
                      <td className="num nowrap">{lpa(r.current_ctc_lpa)}</td>
                      <td className="num nowrap">{lpa(r.expected_ctc_lpa)}</td>
                      {questions.map(q => (
                        <td key={q.id} className="small" style={{ minWidth: 140, maxWidth: 220 }}><span className="clamp-2">{answerFor(r, q)}</span></td>
                      ))}
                      <td className="muted small" style={{ minWidth: 180, maxWidth: 340 }}>
                        <span className="clamp-2">
                          {r.call?.summary || (r.status === 'failed' ? (r.failure_reason || r.call?.failure_reason) : r.call?.status === 'completed' ? 'Summary being written…' : '')}
                        </span>
                      </td>
                      <td className="actions" onClick={e => e.stopPropagation()}>
                        {r.status === 'failed' && (
                          <button className="btn btn-sm" onClick={() => retake(r)} disabled={busy !== null} title="Let this candidate take the call again">
                            <RotateCcw size={14} /> Retake
                          </button>
                        )}
                        {r.call && (
                          <button className="btn btn-ghost btn-icon" onClick={() => setOpenCallId(r.call!.id)} aria-label={`Open ${r.name}'s call`}>
                            <ChevronRight size={16} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {openCallId && <CandidateResultDrawer callId={openCallId} onClose={() => setOpenCallId(null)} />}
    </div>
  );
};
