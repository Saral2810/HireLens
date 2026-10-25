import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle } from 'lucide-react';
import { api } from '../../services/api';
import { CandidatePortal } from '../../types';
import { ResumeUpload } from '../../components/candidate/ResumeUpload';
import { MicCheck } from '../../components/candidate/MicCheck';
import { CallPanel, CallOutcome } from '../../components/candidate/CallPanel';
import { ErrorNote } from '../../components/ui/Modal';

const DONE_TEXT: Partial<Record<CandidatePortal['status'], string>> = {
  in_call: 'Your screening call is open in another tab or window. If you closed it, wait three minutes and reload this page.',
  completed: 'Your screening call is complete. Thank you! The HR team will contact you.',
  failed: 'Your screening call did not finish. The answers you gave are saved. Please contact the HR team if you would like another try.'
};

const Step: React.FC<{ n: number; title: string; done: boolean; children: React.ReactNode }> = ({ n, title, done, children }) => (
  <section style={{ border: '1px solid var(--lx-border)', borderRadius: 10, padding: '16px 18px', marginBottom: 14 }}>
    <h3 style={{ margin: '0 0 10px', fontSize: 16, display: 'flex', alignItems: 'center', gap: 8 }}>
      {done ? <CheckCircle2 size={18} color="#22c55e" /> : <Circle size={18} color="var(--lx-muted)" />}
      Step {n}: {title}
    </h3>
    {children}
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
    return <div>{error ? <ErrorNote message={error} /> : <p style={{ color: 'var(--lx-muted)' }}>Loading…</p>}</div>;
  }

  const batch = me.batch;
  const finished = DONE_TEXT[me.status];
  const ready = me.has_resume && me.consent_given && micOk;

  return (
    <div style={{ maxWidth: 680 }}>
      <h2 style={{ marginTop: 0 }}>Hi {me.name},</h2>
      <p style={{ fontSize: 15, lineHeight: 1.6 }}>
        You have been invited to a short voice screening (about 5 minutes) for the role of <strong>{batch?.job_role}</strong>
        {batch?.company_name ? <> at <strong>{batch.company_name}</strong></> : null}. An AI assistant will ask the questions; you answer by speaking, in English, Hindi or Hinglish.
      </p>
      <ErrorNote message={error} />

      {notice && <p style={{ fontSize: 14, color: 'var(--lx-muted)' }}>{notice}</p>}

      {finished && !inCall ? (
        <p style={{ fontSize: 15 }}>{finished}</p>
      ) : (
        <>
          {/* Steps 1 and 2 are hidden during the call; step 3 stays in place so the call keeps running. */}
          {!inCall && (
            <>
              <Step n={1} title="Upload your resume" done={me.has_resume}>
                <ResumeUpload hasResume={me.has_resume} onUploaded={load} />
              </Step>

              <Step n={2} title="Check your microphone" done={micOk && me.consent_given}>
                <MicCheck heard={micOk} onHeard={() => setMicOk(true)} />
                <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', marginTop: 14, fontSize: 14, lineHeight: 1.5 }}>
                  <input type="checkbox" checked={me.consent_given} disabled={me.consent_given || consentBusy} onChange={e => consent(e.target.checked)} style={{ marginTop: 4 }} />
                  <span>I agree that this screening call is recorded and transcribed, and that my answers and recording are shared with the hiring team for this role.</span>
                </label>
              </Step>
            </>
          )}

          <Step n={3} title="Screening call" done={false}>
            <CallPanel ready={ready} onStart={() => { setNotice(null); setInCall(true); }} onFinished={callFinished} />
          </Step>
        </>
      )}
      <p style={{ color: 'var(--lx-muted)', fontSize: 12 }}>Batch: {batch?.name}</p>
    </div>
  );
};
