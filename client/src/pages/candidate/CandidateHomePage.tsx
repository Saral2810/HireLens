import React, { useCallback, useEffect, useState } from 'react';
import { Check, CheckCircle2, Clock, Info, Languages, LogOut, PhoneOff, RotateCcw, SearchX, Square } from 'lucide-react';
import { api } from '../../services/api';
import { CandidatePortal } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { StatusBadge } from '../../components/hr/StatusBadge';
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
    text: 'The answers you gave are saved. You have used all your tries, so please contact the HR team if you would like another one.'
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
  const [retrying, setRetrying] = useState(false);
  const [missing, setMissing] = useState<string | null>(null);
  const { currentUser, logout } = useAppStore();

  const load = useCallback(async () => {
    try {
      setMe(await api.candidateMe());
      setMissing(null);
    } catch (err: any) {
      // Signed in, but HR has not added this email to a running campaign.
      if (/No screening found/i.test(err.message)) setMissing(err.message); else setError(err.message);
    }
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

  const retry = async () => {
    setRetrying(true);
    setError(null);
    try {
      await api.retryCall();
      setNotice('You can take the call again. Check your microphone, then start the call.');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setRetrying(false);
    }
  };

  const callFinished = async (outcome: CallOutcome, message?: string) => {
    setInCall(false);
    setError(outcome === 'error' && message ? message : null);
    setNotice(outcome === 'not_ready' ? 'No problem. Start the call again whenever you are ready.' : null);
    await load();
  };

  if (missing) {
    return (
      <div className="container-narrow" style={{ margin: '0 auto' }}>
        <div className="card card-pad" style={{ textAlign: 'center', padding: 36 }}>
          <div className="empty-icon"><SearchX size={22} /></div>
          <h2>No screening found</h2>
          <p className="muted mt-sm" style={{ maxWidth: 460, margin: '8px auto 0', lineHeight: 1.6 }}>
            You are signed in as <strong style={{ color: 'var(--text)' }}>{currentUser?.email}</strong>, but there is no running screening for this address.
            Check with HR that they added this exact email and ran the campaign, or sign in with another email.
          </p>
          <div className="row-wrap mt-lg" style={{ justifyContent: 'center' }}>
            <button className="btn" onClick={load}><RotateCcw size={15} /> Check again</button>
            <button className="btn btn-primary" onClick={() => { logout(); window.location.assign('/login?as=candidate'); }}><LogOut size={15} /> Use another email</button>
          </div>
        </div>
      </div>
    );
  }

  if (!me) {
    return <div className="container-narrow" style={{ margin: '0 auto' }}>{error ? <ErrorNote message={error} /> : <p className="muted">Loading…</p>}</div>;
  }

  const batch = me.batch;
  const closed = batch?.status === 'closed' && !['completed', 'failed'].includes(me.status);
  const finished = closed
    ? { icon: <Square size={20} />, title: 'This screening is closed', text: 'HR has closed this campaign, so new calls cannot start. Please contact the HR team if you still want to take it.' }
    : FINISHED[me.status];
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
          <div className="empty-icon" style={me.status === 'completed' ? { background: 'var(--ink)', color: 'var(--ink-text)', borderColor: 'var(--ink)' } : undefined}>{finished.icon}</div>
          <h2>{finished.title}</h2>
          {me.status === 'failed' && me.retries_left > 0 && batch?.status !== 'closed' ? (
            <>
              <p className="muted" style={{ maxWidth: 460, margin: '8px auto 0' }}>
                {me.failure_reason ? `${me.failure_reason} ` : ''}The answers you gave are saved. You can take the call again from the start.
              </p>
              <button className="btn btn-primary btn-lg mt" onClick={retry} disabled={retrying}>
                <RotateCcw size={16} /> {retrying ? 'Getting ready…' : 'Try the call again'}
              </button>
              <p className="tiny muted mt-sm">{me.retries_left} {me.retries_left === 1 ? 'try' : 'tries'} left</p>
            </>
          ) : (
            <p className="muted" style={{ maxWidth: 440, margin: '8px auto 0' }}>{finished.text}</p>
          )}
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
            <CallPanel ready={ready} languages={me?.batch?.call_languages} onStart={() => { setNotice(null); setInCall(true); }} onFinished={callFinished} />
          </Step>
        </div>
      )}
      <p className="tiny muted mt" style={{ textAlign: 'center' }}>{batch?.name}</p>
    </div>
  );
};
