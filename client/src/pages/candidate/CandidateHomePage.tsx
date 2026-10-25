import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircle2, Circle, PhoneCall } from 'lucide-react';
import { api } from '../../services/api';
import { CandidatePortal } from '../../types';
import { ResumeUpload } from '../../components/candidate/ResumeUpload';
import { MicCheck } from '../../components/candidate/MicCheck';
import { ErrorNote } from '../../components/ui/Modal';

const DONE_TEXT: Partial<Record<CandidatePortal['status'], string>> = {
  in_call: 'Your screening call is in progress.',
  completed: 'Your screening call is complete. Thank you! The HR team will contact you.',
  failed: 'Your screening call did not finish. Please contact the HR team.'
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

/** Candidate portal: resume → mic check and consent → screening call (Phase G). */
export const CandidateHomePage: React.FC = () => {
  const [me, setMe] = useState<CandidatePortal | null>(null);
  const [micOk, setMicOk] = useState(false);
  const [consentBusy, setConsentBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      {finished ? (
        <p style={{ fontSize: 15 }}>{finished}</p>
      ) : (
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

          <Step n={3} title="Screening call" done={false}>
            <p style={{ color: 'var(--lx-muted)', fontSize: 14, marginTop: 0 }}>
              {ready ? 'All set. The call opens here.' : 'Complete steps 1 and 2 to start your call.'}
            </p>
            <button className="lx-restored-btn primary" disabled style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title="The call screen arrives in the next build phase">
              <PhoneCall size={14} /> Start call
            </button>
          </Step>
        </>
      )}
      <p style={{ color: 'var(--lx-muted)', fontSize: 12 }}>Batch: {batch?.name}</p>
    </div>
  );
};
