import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { AlarmClock, ArrowLeft, Building2, CalendarDays, Check, Copy, Info, Pencil, Play, Square, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { BatchDetail, CandidateStatus } from '../../types';
import { BatchFormModal } from '../../components/hr/BatchFormModal';
import { DeleteCampaignModal, deletedNotice } from '../../components/hr/DeleteCampaignModal';
import { QuestionEditor } from '../../components/hr/QuestionEditor';
import { CandidatesPanel } from '../../components/hr/CandidatesPanel';
import { ResultsTable } from '../../components/hr/ResultsTable';
import { CampaignBadge } from '../../components/hr/StatusBadge';
import { ErrorNote } from '../../components/ui/Modal';
import { ScheduleModal } from '../../components/hr/ScheduleModal';
import { formatWhen } from '../../lib/schedule';
import { CampaignProgress, formatDate } from './CampaignsPage';

type Tab = 'overview' | 'candidates' | 'questions' | 'results';

const candidateLink = () => `${window.location.origin}/login?as=candidate`;

export function runNotice(emails?: { configured: boolean; queued: number }): string {
  if (!emails?.configured) return "Campaign is live. Invite emails are not set up (SMTP in .env), so copy each candidate's link from the Candidates tab.";
  if (!emails.queued) return 'Campaign is live. Everyone has already been emailed their invite.';
  return `Campaign is live. Sending invite emails to ${emails.queued} candidate${emails.queued === 1 ? '' : 's'}; the Candidates tab shows each one as it goes out.`;
}

/** One campaign: overview with Run/Close, candidates, HR questions and results. */
export const CampaignPage: React.FC = () => {
  const { campaignId = '' } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [scheduling, setScheduling] = useState(false);
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

  const act = async <T,>(fn: () => Promise<T>, message: string | ((result: T) => string)) => {
    setBusy(true);
    setError(null);
    try {
      const result = await fn();
      setNotice(typeof message === 'function' ? message(result) : message);
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
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
          <div className="row mb-sm"><CampaignBadge status={status} scheduled={!!batch.scheduled_at} /><span className="label">{batch.launched_at ? `Running since ${new Date(batch.launched_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}` : 'Not running yet'}</span></div>
          <h1>{batch.name}</h1>
          <div className="row-wrap small muted mt-sm" style={{ gap: 14 }}>
            <span className="strong" style={{ color: 'var(--text-2)' }}>{batch.job_role}</span>
            {batch.company_name && <span className="row" style={{ gap: 4 }}><Building2 size={14} /> {batch.company_name}</span>}
            <span className="row" style={{ gap: 4 }}><CalendarDays size={14} /> {formatDate(batch.batch_date)}</span>
          </div>
        </div>
        <div className="btn-group">
          <button className="btn" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
          <button className="btn btn-danger" onClick={() => setDeleting(true)}><Trash2 size={14} /> Delete</button>
          {status !== 'closed' && (
            <button className="btn" disabled={busy || (status === 'draft' && counts.total === 0)} title={status === 'draft' && counts.total === 0 ? 'Add candidates first' : undefined} onClick={() => setScheduling(true)}>
              <AlarmClock size={14} /> {status === 'draft' ? (batch.scheduled_at ? 'Reschedule' : 'Schedule') : 'Close time'}
            </button>
          )}
          {status === 'live'
            ? <button className="btn" disabled={busy} onClick={() => window.confirm('Close this campaign? Candidates who have not finished will not be able to start a call.') && act(() => api.closeCampaign(batch.id), 'Campaign closed. Results stay available.')}><Square size={14} /> Close</button>
            : <button className="btn btn-primary" disabled={busy || counts.total === 0} title={counts.total === 0 ? 'Add candidates first' : undefined}
                onClick={() => act(() => api.runCampaign(batch.id), ({ emails }) => runNotice(emails))}>
                <Play size={14} /> {status === 'closed' ? 'Reopen' : 'Run campaign'}
              </button>}
        </div>
      </div>
      <ErrorNote message={error} />
      {notice && <div className="alert" role="status"><Check size={15} /><span>{notice}</span></div>}
      {(batch.scheduled_at || batch.closes_at) && (
        <div className="alert alert-info" role="status">
          <AlarmClock size={15} />
          <span className="grow">
            {status === 'draft' && batch.scheduled_at && <>Starts by itself on <strong>{formatWhen(batch.scheduled_at)}</strong>; every candidate is emailed their invite then. </>}
            {batch.closes_at && <>Closes by itself on <strong>{formatWhen(batch.closes_at)}</strong>.</>}
          </span>
          <button className="btn btn-sm" disabled={busy} onClick={() => act(() => api.unscheduleCampaign(batch.id), 'Schedule removed.')}>Remove schedule</button>
        </div>
      )}

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
                ? (batch.email?.configured
                  ? 'Each candidate gets an email with a personal link that opens their screening directly. The Candidates tab shows who was emailed and lets you send it again. Candidates can also use the sign-in page below with the email you added.'
                  : 'Invite emails are not set up yet (SMTP settings in .env). Open the Candidates tab and send each person their own invite link, or share the sign-in page below.')
                : status === 'draft'
                  ? (batch.scheduled_at
                    ? `This campaign is scheduled: candidates cannot see it until ${formatWhen(batch.scheduled_at)}, when it starts and their invite emails go out. You can still add candidates and change questions.`
                    : 'This campaign is a draft: candidates cannot see it yet. Add candidates, check the questions, then press Run campaign, or Schedule it for a later day.')
                  : 'This campaign is closed: candidates who have not finished cannot start a call. Reopen it to continue.'}
            </p>
            <div className="row mt">
              <input className="input mono" readOnly value={candidateLink()} onFocus={e => e.target.select()} aria-label="Candidate sign-in link" style={{ fontSize: 13 }} />
              <button className="btn" style={{ height: 40 }} onClick={copyLink}>{copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
        </div>
      )}
      {tab === 'candidates' && <CandidatesPanel batchId={batch.id} candidates={batch.candidates} live={status === 'live'} emailConfigured={!!batch.email?.configured} onReload={load} />}
      {tab === 'questions' && <QuestionEditor batchId={batch.id} questions={batch.questions} onChange={(questions) => setBatch({ ...batch, questions })} />}
      {tab === 'results' && <ResultsTable batchId={batch.id} onCandidatesChanged={load} />}

      {scheduling && (
        <ScheduleModal
          batch={batch}
          onClose={() => setScheduling(false)}
          onSaved={(updated) => { setBatch({ ...batch, ...updated }); setScheduling(false); setNotice(updated.scheduled_at ? `Scheduled. The campaign starts on ${formatWhen(updated.scheduled_at)}.` : 'Close time saved.'); }}
        />
      )}
      {editing && (
        <BatchFormModal
          batch={batch}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setBatch({ ...batch, ...updated }); setEditing(false); setNotice('Campaign details saved. Calls that start from now use them.'); }}
        />
      )}
      {deleting && (
        <DeleteCampaignModal
          batch={{ ...batch, counts }}
          onClose={() => setDeleting(false)}
          onDeleted={(result) => navigate('/hr/campaigns', { replace: true, state: { notice: deletedNotice(batch.name, result) } })}
        />
      )}
    </div>
  );
};
