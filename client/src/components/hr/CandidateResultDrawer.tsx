import React, { useEffect, useState } from 'react';
import { Clock, FileText, X } from 'lucide-react';
import { api } from '../../services/api';
import { CallDetail, ResultAnswer } from '../../types';
import { ErrorNote, useEscape } from '../ui/Modal';
import { ScorePill, StatusBadge } from './StatusBadge';
import { days, lpa } from './ResultsTable';

const SOURCE_TITLES: Record<ResultAnswer['source'], string> = {
  intro: 'Opening', general: 'Their projects and problems solved', resume: 'About their resume', hr: 'HR questions'
};

const time = (iso: string) => new Date(iso).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** One candidate's call: summary, key numbers, every answer, the recording and the full transcript. */
export const CandidateResultDrawer: React.FC<{ callId: string; onClose: () => void }> = ({ callId, onClose }) => {
  const [detail, setDetail] = useState<CallDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openedAt] = useState(() => Date.now());
  const [, tick] = useState(0);
  useEscape(onClose);

  useEffect(() => {
    api.getCall(callId).then(setDetail).catch(err => setError(err.message));
  }, [callId]);

  // Re-render every 30 s so the "links expired" note appears on time.
  useEffect(() => {
    const timer = setInterval(() => tick(n => n + 1), 30000);
    return () => clearInterval(timer);
  }, []);

  const expired = detail ? Date.now() - openedAt > detail.links_expire_in_seconds * 1000 : false;
  const groups = (['intro', 'general', 'resume', 'hr'] as const)
    .map(source => ({ source, answers: detail?.answers.filter(a => a.source === source) || [] }))
    .filter(g => g.answers.length);

  return (
    <div className="backdrop backdrop-drawer" role="dialog" aria-modal="true" aria-label="Candidate result"
      onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer">
        <div className="drawer-head">
          <div className="grow">
            <h2>{detail?.name || 'Loading…'}</h2>
            {detail && (
              <div className="row-wrap small muted mt-sm" style={{ gap: 10 }}>
                <StatusBadge status={detail.status} />
                {detail.call && <span className="row" style={{ gap: 4 }}><Clock size={13} /> {time(detail.call.started_at)}{detail.call.duration_seconds != null && ` · ${Math.max(1, Math.round(detail.call.duration_seconds / 60))} min`}</span>}
                {detail.attempts > 1 && <span className="tag">Attempt {detail.attempts}</span>}
              </div>
            )}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="drawer-body">
          <ErrorNote message={error} />
          {detail && (
            <>
              <section className="card card-pad">
                <div className="row mb-sm">
                  <h4 className="grow">Assessment</h4>
                  <span className="tiny muted">Fit score</span>
                  <ScorePill score={detail.call?.fit_score} />
                </div>
                <p style={{ lineHeight: 1.6 }}>{detail.call?.summary || detail.call?.failure_reason || 'No summary yet.'}</p>
                <div className="stat-row mt" style={{ marginBottom: 0, gridTemplateColumns: 'repeat(3, 1fr)' }}>
                  <div><div className="tiny muted">Notice period</div><div className="strong">{days(detail.notice_period_days)}</div></div>
                  <div><div className="tiny muted">Current CTC</div><div className="strong">{lpa(detail.current_ctc_lpa)}</div></div>
                  <div><div className="tiny muted">Expected CTC</div><div className="strong">{lpa(detail.expected_ctc_lpa)}</div></div>
                </div>
              </section>

              <section className="card card-pad">
                <div className="row mb-sm">
                  <h4 className="grow">Recording</h4>
                  {detail.resume_url && !expired && (
                    <a className="btn btn-sm" href={detail.resume_url} target="_blank" rel="noreferrer"><FileText size={14} /> Resume</a>
                  )}
                </div>
                {detail.recording_url && !expired ? (
                  <audio controls src={detail.recording_url} />
                ) : (
                  <p className="small muted">
                    {expired ? 'The links have expired (10 minutes). Close and reopen to get new ones.' : 'No recording for this call.'}
                  </p>
                )}
              </section>

              {groups.map(g => (
                <section key={g.source} className="card card-pad">
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
                </section>
              ))}

              <section>
                <h4 className="mb-sm">Transcript</h4>
                <div className="chat">
                  {detail.transcript.map((t, i) => (
                    <div key={i} className={`bubble ${t.speaker === 'agent' ? 'bubble-agent' : 'bubble-you'}`}>
                      <div className="bubble-who">{t.speaker === 'agent' ? 'Assistant' : detail.name}</div>
                      {t.text || <em className="muted">(nothing heard)</em>}
                    </div>
                  ))}
                </div>
              </section>
            </>
          )}
        </div>
      </aside>
    </div>
  );
};
