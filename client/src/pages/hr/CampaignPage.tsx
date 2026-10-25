import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, CalendarDays, Check, Copy, Info, Pencil, Play, Square, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { BatchDetail, CandidateStatus } from '../../types';
import { BatchFormModal } from '../../components/hr/BatchFormModal';
import { QuestionEditor } from '../../components/hr/QuestionEditor';
import { CandidatesPanel } from '../../components/hr/CandidatesPanel';
import { ResultsTable } from '../../components/hr/ResultsTable';
import { CampaignBadge } from '../../components/hr/StatusBadge';
import { ErrorNote } from '../../components/ui/Modal';
import { CampaignProgress, formatDate } from './CampaignsPage';

type Tab = 'overview' | 'candidates' | 'questions' | 'results';

const candidateLink = () => `${window.location.origin}/login?as=candidate`;

/** One campaign: overview with Run/Close, candidates, HR questions and results. */
export const CampaignPage: React.FC = () => {
  const { campaignId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [notice, setNotice] = useState<string | null>((location.state as { notice?: string } | null)?.notice || null);
  const [error, setError] = useState<string | null>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    try {
      const loaded = await api.getBatch(campaignId);
      if (firstLoad.current && loaded.candidates.some(c => c.status === 'completed' || c.status === 'failed')) setTab('results');
      firstLoad.current = false;
      setBatch(loaded);
    } catch (err: any) {
      setError(err.message);
    }
  }, [campaignId]);
  useEffect(() => { load(); }, [load]);

  const act = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNotice(message);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!batch || !window.confirm(`Delete "${batch.name}" with its questions and candidates? This cannot be undone.`)) return;
    try {
      await api.deleteBatch(batch.id);
      navigate('/hr/campaigns', { replace: true });
    } catch (err: any) {
      setError(err.message);
    }
  };

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(candidateLink()); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* shown below anyway */ }
  };

  const back = <Link to="/hr/campaigns" className="back-link"><ArrowLeft size={14} /> Campaigns</Link>;
  if (!batch) return <div>{back}<ErrorNote message={error} />{!error && <p className="muted">Loading…</p>}</div>;

  const status = batch.status || 'draft';
  const count = (s: CandidateStatus) => batch.candidates.filter(c => c.status === s).length;
  const counts = {
    total: batch.candidates.length, invited: count('invited'), resume_uploaded: count('resume_uploaded'),
    in_call: count('in_call'), completed: count('completed'), failed: count('failed')
  };
  const tabs: { id: Tab; label: string; n?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'candidates', label: 'Candidates', n: counts.total },
    { id: 'questions', label: 'HR questions', n: batch.questions.length },
    { id: 'results', label: 'Results', n: counts.completed }
  ];

  return (
    <div>
      {back}
      <div className="page-head">
        <div>
          <div className="row mb-sm"><CampaignBadge status={status} /><span className="label">{batch.launched_at ? `Running since ${new Date(batch.launched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'Not running yet'}</span></div>
          <h1>{batch.name}</h1>
          <div className="row-wrap small muted mt-sm" style={{ gap: 14 }}>
            <span className="strong" style={{ color: 'var(--text-2)' }}>{batch.job_role}</span>
            {batch.company_name && <span className="row" style={{ gap: 4 }}><Building2 size={14} /> {batch.company_name}</span>}
            <span className="row" style={{ gap: 4 }}><CalendarDays size={14} /> {formatDate(batch.batch_date)}</span>
          </div>
        </div>
        <div className="btn-group">
          <button className="btn" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
          {status === 'draft' && counts.invited === counts.total && <button className="btn btn-danger" onClick={remove}><Trash2 size={14} /> Delete</button>}
          {status === 'live'
            ? <button className="btn" disabled={busy} onClick={() => window.confirm('Close this campaign? Candidates who have not finished will not be able to start a call.') && act(() => api.closeCampaign(batch.id), 'Campaign closed. Results stay available.')}><Square size={14} /> Close</button>
            : <button className="btn btn-primary" disabled={busy || counts.total === 0} title={counts.total === 0 ? 'Add candidates first' : undefined}
                onClick={() => act(() => api.runCampaign(batch.id), 'Campaign is live. Candidates can sign in and take the call.')}>
                <Play size={14} /> {status === 'closed' ? 'Reopen' : 'Run campaign'}
              </button>}
        </div>
      </div>
      <ErrorNote message={error} />
      {notice && <div className="alert" role="status"><Check size={15} /><span>{notice}</span></div>}

      <div className="tabs" role="tablist">
        {tabs.map(t => (
          <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}{t.n !== undefined && <span className="tab-count">{t.n}</span>}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="stack">
          <div className="stat-row" style={{ marginBottom: 0 }}>
            <div className="stat"><div className="stat-label">Candidates</div><div className="stat-value">{counts.total}</div></div>
            <div className="stat"><div className="stat-label">Not started</div><div className="stat-value">{counts.invited}</div></div>
            <div className="stat"><div className="stat-label">In progress</div><div className="stat-value">{counts.resume_uploaded + counts.in_call}</div></div>
            <div className="stat"><div className="stat-label">Completed</div><div className="stat-value">{counts.completed}</div></div>
            <div className="stat"><div className="stat-label">Did not finish</div><div className="stat-value">{counts.failed}</div></div>
          </div>
          <div className="card card-pad"><h4 className="mb-sm">Progress</h4><CampaignProgress batch={{ ...batch, counts }} /></div>
          <div className="card card-pad">
            <h4 className="row"><Info size={15} /> How candidates join</h4>
            <p className="muted small mt-sm" style={{ lineHeight: 1.6 }}>
              {status === 'live'
                ? 'Share the sign-in link below with your candidates. They choose "Candidate", sign in with Google or an email code using the address you added, and their call is waiting in their dashboard. No emails are sent by the app.'
                : status === 'draft'
                  ? 'This campaign is a draft: candidates cannot see it yet. Add candidates, check the questions, then press Run campaign.'
                  : 'This campaign is closed: candidates who have not finished cannot start a call. Reopen it to continue.'}
            </p>
            <div className="row mt">
              <input className="input mono" readOnly value={candidateLink()} onFocus={e => e.target.select()} aria-label="Candidate sign-in link" style={{ fontSize: 13 }} />
              <button className="btn" style={{ height: 40 }} onClick={copyLink}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        </div>
      )}
      {tab === 'candidates' && <CandidatesPanel batchId={batch.id} candidates={batch.candidates} onReload={load} />}
      {tab === 'questions' && <QuestionEditor batchId={batch.id} questions={batch.questions} onChange={(questions) => setBatch({ ...batch, questions })} />}
      {tab === 'results' && <ResultsTable batchId={batch.id} onCandidatesChanged={load} />}

      {editing && (
        <BatchFormModal
          batch={batch}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setBatch({ ...batch, ...updated }); setEditing(false); }}
        />
      )}
    </div>
  );
};
