import React, { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft, Clock, FileText, Printer } from 'lucide-react';
import { api } from '../../services/api';
import { CallDetail, ResultAnswer } from '../../types';
import { ErrorNote } from '../../components/ui/Modal';
import { ScorePill, StatusBadge } from '../../components/hr/StatusBadge';
import { days, lpa } from '../../components/hr/ResultsTable';
import { AtsScoreBreakdown, FitScoreBreakdown, ScoreHelp } from '../../components/hr/ScoreBreakdown';

const SOURCE_TITLES: Record<ResultAnswer['source'], string> = {
  intro: 'Opening', general: 'Their projects and problems solved', resume: 'About their resume', hr: 'HR questions'
};

const SECTIONS = [
  { id: 'overview', label: 'Overview' },
  { id: 'scores', label: 'Scores' },
  { id: 'answers', label: 'Answers' },
  { id: 'recording', label: 'Recording' },
  { id: 'transcript', label: 'Transcript' }
];

const when = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * /hr/calls/:callId/summary — everything about one call on one page, in reading order: the overview
 * (summary and key facts), both scores with their breakdowns, every answer, the recording and resume,
 * and the full transcript. Printable (or save as PDF) for sharing with a hiring manager.
 */
export const CallSummaryPage: React.FC = () => {
  const { callId = '' } = useParams();
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());

  useEffect(() => {
    api.getCall(callId).then(setDetail).catch(err => setError(err.message));
  }, [callId]);

  const back = detail?.campaign
    ? <Link to={`/hr/campaigns/${detail.campaign.id}`} className="back-link no-print"><ArrowLeft size={14} /> {detail.campaign.name}</Link>
    : <Link to="/hr/campaigns" className="back-link no-print"><ArrowLeft size={14} /> Campaigns</Link>;
  if (!detail) return <div>{back}<ErrorNote message={error} />{!error && <p className="muted">Loading the call summary…</p>}</div>;

  const call = detail.call;
  const expired = Date.now() - openedAt > detail.links_expire_in_seconds * 1000;
  const groups = (['intro', 'general', 'resume', 'hr'] as const)
    .map(source => ({ source, answers: detail.answers.filter(a => a.source === source) }))
    .filter(g => g.answers.length);

  return (
    <div style={{ maxWidth: 980 }}>
      {back}
      <div className="page-head">
        <div>
          <span className="eyebrow">Summary of call</span>
          <h1>{detail.name}</h1>
          <div className="row-wrap small muted mt-sm" style={{ gap: 12 }}>
            <StatusBadge status={detail.status} />
            <span>{detail.email}</span>
            {detail.campaign && <span>{detail.campaign.job_role}{detail.campaign.company_name ? ` · ${detail.campaign.company_name}` : ''}</span>}
            {call && <span className="row" style={{ gap: 4 }}><Clock size={13} /> {when(call.started_at)}{call.duration_seconds != null && ` · ${Math.max(1, Math.round(call.duration_seconds / 60))} min`}</span>}
            {detail.attempts > 1 && <span className="tag">Attempt {detail.attempts}</span>}
          </div>
        </div>
        <button className="btn no-print" onClick={() => window.print()}><Printer size={14} /> Print or save as PDF</button>
      </div>

      <nav className="summary-nav row-wrap" aria-label="Sections" style={{ gap: 6 }}>
        {SECTIONS.map(s => <a key={s.id} className="btn btn-sm btn-ghost" href={`#${s.id}`}>{s.label}</a>)}
      </nav>

      <div className="stack">
        <section id="overview" className="summary-section card card-pad">
          <div className="summary-grid">
            <div>
              <div className="tiny muted">Fit score</div>
              <div className="row" style={{ gap: 10 }}><span className="score-big">{call?.fit_score ?? '—'}</span><span className="muted">/ 100</span></div>
            </div>
            <div>
              <div className="tiny muted">ATS score of the resume</div>
              <div className="row" style={{ gap: 10 }}><span className="score-big">{detail.ats_score ?? '—'}</span><span className="muted">/ 100</span></div>
            </div>
          </div>
          <h4 className="mt">Summary</h4>
          <p style={{ lineHeight: 1.6 }}>{call?.summary || call?.failure_reason || detail.failure_reason || 'No summary yet.'}</p>
          <div className="stat-row mt" style={{ marginBottom: 0, gridTemplateColumns: 'repeat(3, 1fr)' }}>
            <div><div className="tiny muted">Notice period</div><div className="strong">{days(detail.notice_period_days)}</div></div>
            <div><div className="tiny muted">Current CTC</div><div className="strong">{lpa(detail.current_ctc_lpa)}</div></div>
            <div><div className="tiny muted">Expected CTC</div><div className="strong">{lpa(detail.expected_ctc_lpa)}</div></div>
          </div>
        </section>

        <section id="scores" className="summary-section">
          <div className="summary-grid">
            <div className="card card-pad">
              <div className="row mb"><h4 className="grow">Fit score breakdown</h4><ScorePill score={call?.fit_score} /></div>
              <FitScoreBreakdown breakdown={call?.fit_breakdown} score={call?.fit_score} />
            </div>
            <div className="card card-pad">
              <div className="row mb"><h4 className="grow">ATS score breakdown</h4><ScorePill score={detail.ats_score} /></div>
              <AtsScoreBreakdown breakdown={detail.ats_breakdown} />
            </div>
          </div>
          <div className="mt"><ScoreHelp /></div>
        </section>

        <section id="answers" className="summary-section stack">
          {groups.length === 0 && <div className="card card-pad muted small">No answers saved.</div>}
          {groups.map(g => (
            <div key={g.source} className="card card-pad">
              <h4 className="mb-sm">{SOURCE_TITLES[g.source]}</h4>
              {g.answers.map(a => (
                <div key={a.position} className="qa">
                  <div className="qa-q">{a.question_text}</div>
                  <div className={`qa-a${a.outcome === 'skipped' ? ' skipped' : ''}`}>
                    {a.display || '—'}
                    {a.answer_type !== 'text' && a.outcome === 'answered' && a.answer_text && a.answer_text !== a.display && (
                      <span className="tiny muted" style={{ fontWeight: 400 }}> · “{a.answer_text}”</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </section>

        <section id="recording" className="summary-section card card-pad no-print">
          <div className="row mb-sm">
            <h4 className="grow">Recording and resume</h4>
            {detail.resume_url && !expired && <a className="btn btn-sm" href={detail.resume_url} target="_blank" rel="noreferrer"><FileText size={14} /> Open resume</a>}
          </div>
          {detail.recording_url && !expired
            ? <audio controls src={detail.recording_url} style={{ width: '100%' }} />
            : <p className="small muted">{expired ? 'The links have expired (10 minutes). Reload the page to get new ones.' : 'No recording for this call.'}</p>}
        </section>

        <section id="transcript" className="summary-section">
          <h4 className="mb-sm">Transcript</h4>
          {detail.transcript.length === 0 && <p className="small muted">No transcript.</p>}
          <div className="chat">
            {detail.transcript.map((t, i) => (
              <div key={i} className={`bubble ${t.speaker === 'agent' ? 'bubble-agent' : 'bubble-you'}`}>
                <div className="bubble-who">{t.speaker === 'agent' ? 'Voice agent' : detail.name}</div>
                {t.text || <em className="muted">(nothing heard)</em>}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
