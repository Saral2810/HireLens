import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, FolderPlus, Plus } from 'lucide-react';
import { api } from '../../services/api';
import { Analytics } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { EmptyState, ErrorNote } from '../../components/ui/Modal';
import { ScorePill } from '../../components/hr/StatusBadge';
import { CandidateResultDrawer } from '../../components/hr/CandidateResultDrawer';

const minutes = (s: number | null) => (s === null ? '—' : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`);
const shortDay = (day: string) => new Date(`${day}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const Stat: React.FC<{ label: string; value: React.ReactNode; sub?: string }> = ({ label, value, sub }) => (
  <div className="stat">
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    {sub && <div className="stat-sub">{sub}</div>}
  </div>
);

/** Calls finished per day: completed (solid) and did not finish (hatched). */
const PerDayChart: React.FC<{ data: Analytics['per_day'] }> = ({ data }) => {
  const max = Math.max(1, ...data.map(d => d.completed + d.failed));
  return (
    <div>
      <div className="bars" role="img" aria-label={`Calls per day, last ${data.length} days`}>
        {data.map((d, i) => (
          <div key={d.day} className="bar-col" title={`${shortDay(d.day)}: ${d.completed} completed, ${d.failed} did not finish`}>
            <div className="bar-stack">
              <div className="bar-fill alt" style={{ height: `${(d.failed / max) * 100}%` }} />
              <div className="bar-fill" style={{ height: `${(d.completed / max) * 100}%` }} />
            </div>
            <span className="bar-x">{(data.length - 1 - i) % 2 === 0 ? shortDay(d.day) : ' '}</span>
          </div>
        ))}
      </div>
      <div className="legend mt-sm"><span><i className="swatch" /> Completed</span><span><i className="swatch alt" /> Did not finish</span></div>
    </div>
  );
};

const HBars: React.FC<{ rows: { label: string; count: number }[] }> = ({ rows }) => {
  const max = Math.max(1, ...rows.map(r => r.count));
  return (
    <div>
      {rows.map(r => (
        <div key={r.label} className="hbar">
          <span className="muted">{r.label}</span>
          <div className="hbar-track"><div style={{ width: `${(r.count / max) * 100}%` }} /></div>
          <span className="num">{r.count}</span>
        </div>
      ))}
    </div>
  );
};

/** HR home: analytics across every campaign the user can see. */
export const DashboardPage: React.FC = () => {
  const { currentUser } = useAppStore();
  const [data, setData] = useState<Analytics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openCall, setOpenCall] = useState<string | null>(null);

  useEffect(() => { api.analytics().then(setData).catch(err => setError(err.message)); }, []);
  const firstName = (currentUser?.name || '').split(' ')[0];

  return (
    <div>
      <div className="page-head">
        <div>
          <span className="eyebrow">{currentUser?.role === 'superadmin' ? 'All campaigns' : 'Your campaigns'}</span>
          <h1>{greeting()}{firstName ? `, ${firstName}` : ''}</h1>
        </div>
        <Link to="/hr/campaigns/new" className="btn btn-primary"><Plus size={16} /> New campaign</Link>
      </div>
      <ErrorNote message={error} />
      {!data && !error && <p className="muted">Loading…</p>}

      {data && data.campaigns.total === 0 && (
        <div className="card">
          <EmptyState icon={<FolderPlus size={20} />} title="No campaigns yet">
            Create a campaign for a job role, add candidates from Excel or by hand, and run it.
            <div className="mt"><Link to="/hr/campaigns/new" className="btn btn-primary"><Plus size={16} /> Create your first campaign</Link></div>
          </EmptyState>
        </div>
      )}

      {data && data.campaigns.total > 0 && (
        <>
          <div className="stat-row">
            <Stat label="Live campaigns" value={data.campaigns.live} sub={`${data.campaigns.total} in total`} />
            <Stat label="Candidates" value={data.candidates.total} sub={`${data.candidates.by_status.completed} completed`} />
            <Stat label="Completion rate" value={data.completion_rate === null ? '—' : `${data.completion_rate}%`} sub="of candidates in running campaigns" />
            <Stat label="Average fit score" value={data.avg_fit_score ?? '—'} sub="out of 100" />
            <Stat label="Average call" value={minutes(data.avg_call_seconds)} sub={`${data.calls.completed} calls completed`} />
          </div>

          <div className="grid-3 mb">
            <div className="card">
              <div className="card-head"><h4>Calls per day</h4><span className="label">last 14 days</span></div>
              <div className="card-body"><PerDayChart data={data.per_day} /></div>
            </div>
            <div className="card">
              <div className="card-head"><h4>Progress</h4><span className="label">all candidates</span></div>
              <div className="card-body"><HBars rows={data.funnel.map(f => ({ label: f.stage, count: f.count }))} /></div>
            </div>
          </div>

          <div className="grid-3 mb">
            <div className="card">
              <div className="card-head"><h4>Recent calls</h4><Link to="/hr/campaigns" className="small">All campaigns</Link></div>
              {data.recent_calls.length === 0 ? (
                <p className="muted small card-body">No finished calls yet.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead><tr><th>Candidate</th><th>Campaign</th><th>Result</th><th>Fit</th><th className="actions"><span className="sr-only">Open</span></th></tr></thead>
                    <tbody>
                      {data.recent_calls.map(c => (
                        <tr key={c.call_id} onClick={() => setOpenCall(c.call_id)} style={{ cursor: 'pointer' }}>
                          <td className="strong">{c.name}<div className="tiny muted" style={{ fontWeight: 400 }}>{when(c.ended_at)}</div></td>
                          <td className="muted">{c.campaign}</td>
                          <td><span className={`badge ${c.status === 'completed' ? 'badge-solid' : 'badge-dashed'}`}>{c.status === 'completed' ? 'Completed' : 'Did not finish'}</span></td>
                          <td><ScorePill score={c.fit_score} /></td>
                          <td className="actions"><ChevronRight size={16} className="muted" /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div className="stack">
              <div className="card">
                <div className="card-head"><h4>Top candidates</h4><span className="label">by fit score</span></div>
                <div className="card-body">
                  {data.top_candidates.length === 0 ? <p className="muted small">Scores appear after completed calls.</p> : (
                    <ol className="list">
                      {data.top_candidates.map((c, i) => (
                        <li key={c.call_id} className="row" style={{ padding: '8px 0', cursor: 'pointer' }} onClick={() => setOpenCall(c.call_id)}>
                          <span className="list-num">{i + 1}</span>
                          <span className="grow"><span className="strong">{c.name}</span><span className="tiny muted" style={{ display: 'block' }}>{c.campaign}</span></span>
                          <ScorePill score={c.fit_score} />
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
              </div>
              <div className="card">
                <div className="card-head"><h4>Fit scores</h4><span className="label">completed calls</span></div>
                <div className="card-body"><HBars rows={data.score_distribution} /></div>
              </div>
            </div>
          </div>
        </>
      )}

      {openCall && <CandidateResultDrawer callId={openCall} onClose={() => setOpenCall(null)} />}
    </div>
  );
};
