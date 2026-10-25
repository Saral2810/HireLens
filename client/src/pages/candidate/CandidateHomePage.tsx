import React, { useCallback, useEffect, useState } from 'react';
import { Check, CheckCircle2, Clock, Info, Languages, PhoneOff } from 'lucide-react';
import { api } from '../../services/api';
import { CandidatePortal } from '../../types';
import { ResumeUpload } from '../../components/candidate/ResumeUpload';
import { MicCheck } from '../../components/candidate/MicCheck';
import { CallPanel, CallOutcome } from '../../components/candidate/CallPanel';
import { ErrorNote } from '../../components/ui/Modal';

const FINISHED: Partial<Record<CandidatePortal['status'], { icon: React.ReactNode; title: string; text: string }>> = {
  in_call: {
    icon: <Clock size={22} />, title: 'Your call is open elsewhere',
    text: 'Your screening call is open in another tab or window. If you closed it, wait three minutes and reload this page.'
  },
  completed: {
    icon: <CheckCircle2 size={22} />, title: 'Call completed. Thank you!',
    text: 'Your answers have been shared with the hiring team. They will contact you about the next steps.'
  },
  failed: {
    icon: <PhoneOff size={22} />, title: 'Your call did not finish',
    text: 'The answers you gave are saved. Please contact the HR team if you would like another try.'
  }
};

const Step: React.FC<{ n: number; title: string; done: boolean; current: boolean; children: React.ReactNode }> = ({ n, title, done, current, children }) => (
  <section className={`step${done ? ' done' : ''}${current ? ' current' : ''}`}>
    <div className="step-head">
      <span className="step-num">{done ? <Check size={15} /> : n}</span>
      <h3>{title}</h3>
    </div>
    <div className="step-body">{children}</div>
  </section>
);

/** Candidate portal: resume → mic check and consent → screening call. */
export const CandidateHomePage: React.FC = () => {
  const [me, setMe] = useState<CandidatePortal | null>(null);
  const [micOk, setMicOk] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inCall, setInCall] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setMe(await api.candidateMe()); } catch (err: any) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const consent = async (checked: boolean) => {
    if (!checked || !me) return;
    setConsentBusy(true);
    setError(null);
    try {
      await api.giveConsent();
      setMe({ ...me, consent_given: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setConsentBusy(false);
    }
  };

  const callFinished = async (outcome: CallOutcome, message?: string) => {
    setInCall(false);
    setError(outcome === 'error' && message ? message : null);
    setNotice(outcome === 'not_ready' ? 'No problem. Start the call again whenever you are ready.' : null);
    await load();
  };

  if (!me) {
    return <div className="container-narrow" style={{ margin: '0 auto' }}>{error ? <ErrorNote message={error} /> : <p className="muted">Loading…</p>}</div>;
  }

  const batch = me.batch;
  const finished = FINISHED[me.status];
  const step2Done = micOk && me.consent_given;
  const ready = me.has_resume && step2Done;
  const firstName = me.name.split(' ')[0];

  return (
    <div className="container-narrow" style={{ margin: '0 auto' }}>
      {!inCall && (
        <div className="hero">
          <h1>Hi {firstName}, welcome!</h1>
          <p>
            You're invited to a short voice screening for <strong>{batch?.job_role}</strong>
            {batch?.company_name ? <> at <strong>{batch.company_name}</strong></> : null}. An AI assistant asks the questions and you answer by speaking.
          </p>
          <div className="hero-meta">
            <span><Clock size={12} style={{ verticalAlign: -1 }} /> About 5 minutes</span>
            <span><Languages size={12} style={{ verticalAlign: -1 }} /> English, Hindi or Hinglish</span>
          </div>
        </div>
      )}
      <ErrorNote message={error} />
      {notice && <div className="alert alert-info"><Info size={15} /><span>{notice}</span></div>}

      {finished && !inCall ? (
        <div className="card card-pad" style={{ textAlign: 'center', padding: 32 }}>
          <div className="empty-icon" style={me.status === 'completed' ? { background: 'var(--green-soft)', color: 'var(--green)' } : undefined}>{finished.icon}</div>
          <h2>{finished.title}</h2>
          <p className="muted mt-sm" style={{ maxWidth: 440, margin: '8px auto 0' }}>{finished.text}</p>
        </div>
      ) : (
        <div className="steps">
          {/* Steps 1 and 2 are hidden during the call; step 3 stays in place so the call keeps running. */}
          {!inCall && (
            <>
              <Step n={1} title="Upload your resume" done={me.has_resume} current={!me.has_resume}>
                <ResumeUpload hasResume={me.has_resume} onUploaded={load} />
              </Step>

              <Step n={2} title="Check your microphone" done={step2Done} current={me.has_resume && !step2Done}>
                <MicCheck heard={micOk} onHeard={() => setMicOk(true)} />
                <label className="check mt">
                  <input type="checkbox" checked={me.consent_given} disabled={me.consent_given || consentBusy} onChange={e => consent(e.target.checked)} />
                  <span>I agree that this screening call is recorded and transcribed, and that my answers and recording are shared with the hiring team for this role.</span>
                </label>
              </Step>
            </>
          )}

          <Step n={3} title={inCall ? 'Screening call' : 'Take the call'} done={false} current={ready || inCall}>
            <CallPanel ready={ready} onStart={() => { setNotice(null); setInCall(true); }} onFinished={callFinished} />
          </Step>
        </div>
      )}
      <p className="tiny muted mt" style={{ textAlign: 'center' }}>{batch?.name}</p>
    </div>
  );
};
