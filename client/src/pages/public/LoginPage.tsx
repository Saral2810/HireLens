import React, { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ArrowLeft, LogIn, Mail } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/api';
import { Brand, ThemeToggle } from '../../components/layout/AppHeader';
import { CallPreview } from '../../components/public/CallPreview';
import { ErrorNote, Field } from '../../components/ui/Modal';
import { renderGoogleButton } from '../../lib/googleSignIn';

type Who = 'hr' | 'candidate';

/** HR: email + password. */
const HrSignIn: React.FC = () => {
  const { setCurrentUser } = useAppStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api.login(email, password);
      if (res.user) setCurrentUser(res.user);
    } catch (err: any) {
      setError(err.message || 'Invalid email or password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      <ErrorNote message={error} />
      <Field label="Work email">
        <input type="email" required autoComplete="username" className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.in" />
      </Field>
      <Field label="Password">
        <input type="password" required autoComplete="current-password" className="input" value={password} onChange={e => setPassword(e.target.value)} />
      </Field>
      <button type="submit" className="btn btn-primary btn-block btn-lg mt-sm" disabled={busy}>
        <LogIn size={16} /> {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="tiny muted mt">Recruiter accounts are created by your Admin.</p>
    </form>
  );
};

/** Candidate: Google, or a 6-digit code sent to the email HR added. */
const CandidateSignIn: React.FC = () => {
  const { setCurrentUser } = useAppStore();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState<'google' | 'send' | 'verify' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Google's own button is shown only when it is set up; it signs in on this site.
  const [googleReady, setGoogleReady] = useState(false);
  const googleBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.googleSignIn()
      .then(async ({ enabled, client_id }) => {
        if (cancelled || !enabled || !client_id || !googleBox.current) return;
        await renderGoogleButton(googleBox.current, client_id, async (credential, nonce) => {
          setBusy('google');
          setError(null);
          try {
            await api.googleToken(credential, nonce);
            setCurrentUser(await api.getMe());
          } catch (err: any) {
            setError(err.message);
            setBusy(null);
          }
        });
        if (!cancelled) setGoogleReady(true);
      })
      .catch(() => { /* no Google button: the email code still works */ });
    return () => { cancelled = true; };
  }, [setCurrentUser]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('send');
    setError(null);
    try {
      const res = await api.sendEmailCode(email);
      setCodeSent(true);
      setNotice(res.message);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy('verify');
    setError(null);
    try {
      await api.verifyEmailCode(email, code);
      setCurrentUser(await api.getMe());
    } catch (err: any) {
      setError(err.message);
      setBusy(null);
    }
  };

  return (
    <div>
      <ErrorNote message={error} />
      <div ref={googleBox} style={{ display: googleReady ? 'flex' : 'none', justifyContent: 'center', minHeight: googleReady ? 44 : 0 }} aria-busy={busy === 'google'} />
      {busy === 'google' && <p className="small muted" role="status" style={{ textAlign: 'center' }}>Signing you in…</p>}
      {googleReady && <div className="divider">or get a code by email</div>}

      {!codeSent ? (
        <form onSubmit={send}>
          <Field label="Email HR used for your invitation">
            <input type="email" required autoComplete="email" className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@gmail.com" />
          </Field>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy !== null}>
            <Mail size={15} /> {busy === 'send' ? 'Sending…' : 'Email me a code'}
          </button>
        </form>
      ) : (
        <form onSubmit={verify}>
          {notice && <p className="small muted mb">{notice}</p>}
          <Field label="6-digit code">
            <input inputMode="numeric" autoComplete="one-time-code" maxLength={6} required className="input input-code" value={code}
              onChange={e => setCode(e.target.value.replace(/\D/g, ''))} autoFocus aria-label="6-digit code" />
          </Field>
          <button type="submit" className="btn btn-primary btn-block" disabled={busy !== null || code.length !== 6}>
            {busy === 'verify' ? 'Checking…' : 'Sign in'}
          </button>
          <button type="button" className="btn btn-ghost btn-block mt-sm" onClick={() => { setCodeSent(false); setCode(''); setNotice(null); }}>
            <ArrowLeft size={15} /> Use a different email
          </button>
        </form>
      )}
      <p className="tiny muted mt">Sign in with the same email address HR added for your screening. The link in your email works too.</p>
    </div>
  );
};

/** One sign-in page for everyone (reference: split layout, form left, preview right). */
export const LoginPage: React.FC = () => {
  const { inviteError } = useAppStore();
  const [params] = useSearchParams();
  const [who, setWho] = useState<Who>(params.get('as') === 'candidate' || inviteError ? 'candidate' : 'hr');
  useEffect(() => { if (params.get('as') === 'candidate') setWho('candidate'); }, [params]);

  return (
    <div className="auth-split">
      <div className="auth-left dots">
        <div className="row">
          <Brand sub={false} />
          <div className="spacer"><ThemeToggle /></div>
        </div>
        <div className="auth-left-body">
          <div className="card auth-card">
            <h2>Sign in</h2>
            <p className="muted small mt-sm mb">{who === 'hr' ? 'Manage campaigns, candidates and results.' : 'Take your screening call.'}</p>
            <div className="segmented mb" role="group" aria-label="Who is signing in">
              <button type="button" aria-pressed={who === 'hr'} onClick={() => setWho('hr')}>HR team</button>
              <button type="button" aria-pressed={who === 'candidate'} onClick={() => setWho('candidate')}>Candidate</button>
            </div>
            {inviteError && who === 'candidate' && <ErrorNote message={inviteError} />}
            {who === 'hr' ? <HrSignIn /> : <CandidateSignIn />}
          </div>
        </div>
        <p className="tiny muted" style={{ textAlign: 'center' }}>Voice screening with Indian voice agents</p>
      </div>
      <aside className="auth-right">
        <h2 style={{ fontSize: 30, fontWeight: 500, letterSpacing: '-0.03em', maxWidth: 420 }}>
          Every call ends with structured answers, a summary and the recording.
        </h2>
        <p className="muted" style={{ maxWidth: 420 }}>Candidates answer in English, Hindi or Hinglish. HR sees notice period, CTC and a fit score for each one.</p>
        <div style={{ maxWidth: 440 }}><CallPreview /></div>
      </aside>
    </div>
  );
};
