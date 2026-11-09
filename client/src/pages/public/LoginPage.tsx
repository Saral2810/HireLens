import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, LogIn, Mail } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/api';
import { Brand, ThemeToggle } from '../../components/layout/AppHeader';
import { CallPreview } from '../../components/public/CallPreview';
import { ErrorNote, Field } from '../../components/ui/Modal';
import { renderGoogleButton } from '../../lib/googleSignIn';

type Who = 'hr' | 'candidate';

/**
 * Google's own sign-in button, shown only when Google sign-in is set up. `signIn` sends Google's ID
 * token to the server; on success the signed-in user is loaded. Returns the button's box and state.
 */
function useGoogleButton(signIn: (credential: string, nonce: string) => Promise<unknown>, onError: (message: string) => void) {
  const { setCurrentUser } = useAppStore();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.googleSignIn()
      .then(async ({ enabled, client_id }) => {
        if (cancelled || !enabled || !client_id || !box.current) return;
        await renderGoogleButton(box.current, client_id, async (credential, nonce) => {
          setBusy(true);
          onError('');
          try {
            await signIn(credential, nonce);
            setCurrentUser(await api.getMe());
          } catch (err: any) {
            onError(err.message);
            setBusy(false);
          }
        });
        if (!cancelled) setReady(true);
      })
      .catch(() => { /* no Google button: the other sign-in still works */ });
    return () => { cancelled = true; };
  }, [signIn, onError, setCurrentUser]);

  return { box, ready, busy };
}

const signInCandidateWithGoogle = (credential: string, nonce: string) => api.googleToken(credential, nonce);

/**
 * HR: Google, or email + password. When sign-up is open, the Google button also creates a new
 * workspace for someone who has no HR account yet (an existing HR account is simply signed in).
 */
const HrSignIn: React.FC = () => {
  const { setCurrentUser } = useAppStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupOpen, setSignupOpen] = useState(false);
  // Read at click time, so learning whether sign-up is open does not redraw Google's button.
  const signupOpenRef = useRef(false);
  signupOpenRef.current = signupOpen;
  const showError = useCallback((message: string) => setError(message || null), []);
  const signIn = useCallback((credential: string, nonce: string) => (signupOpenRef.current
    ? api.googleHrSignup(credential, nonce, '', '')
    : api.googleHrToken(credential, nonce)), []);
  const google = useGoogleButton(signIn, showError);

  useEffect(() => {
    let cancelled = false;
    api.hrSignupStatus().then(({ open }) => { if (!cancelled) setSignupOpen(open); }).catch(() => { /* sign-in still works */ });
    return () => { cancelled = true; };
  }, []);

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
      {signupOpen && google.ready && (
        <p className="small muted mb" style={{ textAlign: 'center' }}>
          New here? Continue with Google to get your own HR workspace: run up to 3 campaigns with 10 candidates each, and add your team.
        </p>
      )}
      <div ref={google.box} style={{ display: google.ready ? 'flex' : 'none', justifyContent: 'center', minHeight: google.ready ? 44 : 0 }} aria-busy={google.busy} />
      {google.busy && <p className="small muted" role="status" style={{ textAlign: 'center' }}>Signing you in…</p>}
      {google.ready && <div className="divider">or use your email and password</div>}
      <Field label="Work email">
        <input type="email" required autoComplete="username" className="input" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.in" />
      </Field>
      <Field label="Password">
        <input type="password" required autoComplete="current-password" className="input" value={password} onChange={e => setPassword(e.target.value)} />
      </Field>
      <button type="submit" className="btn btn-primary btn-block btn-lg mt-sm" disabled={busy}>
        <LogIn size={16} /> {busy ? 'Signing in…' : 'Sign in'}
      </button>
      <p className="tiny muted mt">{signupOpen
        ? 'Added to a team? Use Google with that email, or the password you were given.'
        : 'Your Admin adds you on the Team page. Then sign in with Google using that email, or with the password they gave you.'}</p>
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
  const showError = useCallback((message: string) => setError(message || null), []);
  // Google's own button is shown only when it is set up; it signs in on this site.
  const google = useGoogleButton(signInCandidateWithGoogle, showError);

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
      <div ref={google.box} style={{ display: google.ready ? 'flex' : 'none', justifyContent: 'center', minHeight: google.ready ? 44 : 0 }} aria-busy={google.busy} />
      {google.busy && <p className="small muted" role="status" style={{ textAlign: 'center' }}>Signing you in…</p>}
      {google.ready && <div className="divider">or get a code by email</div>}

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

/**
 * Sign-up link (/login?signup=<code>): creates the person's own HR workspace with Google. They become
 * its HR lead (never an Admin) and can run campaigns and add HR members, within demo limits.
 */
const HrSignUp: React.FC<{ code: string }> = ({ code }) => {
  const [status, setStatus] = useState<'checking' | 'valid' | 'invalid'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState('');
  // Read at click time, so typing does not redraw Google's button.
  const nameRef = useRef('');
  nameRef.current = workspaceName;
  const showError = useCallback((message: string) => setError(message || null), []);
  const signUp = useCallback((credential: string, nonce: string) => api.googleHrSignup(credential, nonce, code, nameRef.current.trim()), [code]);
  const google = useGoogleButton(signUp, showError);

  useEffect(() => {
    let cancelled = false;
    api.hrSignupStatus(code)
      .then(({ valid }) => { if (!cancelled) setStatus(valid ? 'valid' : 'invalid'); })
      .catch(() => { if (!cancelled) setStatus('invalid'); });
    return () => { cancelled = true; };
  }, [code]);

  if (status === 'invalid') {
    return (
      <div>
        <ErrorNote message="This sign-up link is not valid, or sign-ups are switched off. Ask the person who shared it for a new link." />
        <Link to="/login" className="btn btn-block mt-sm">Go to sign in</Link>
      </div>
    );
  }

  const showButton = status === 'valid' && google.ready;
  return (
    <div>
      <ErrorNote message={error} />
      <Field label="Workspace name" hint="Optional, for example your company's name.">
        <input className="input" maxLength={120} value={workspaceName} onChange={e => setWorkspaceName(e.target.value)} placeholder="Acme Hiring" disabled={google.busy} />
      </Field>
      <div ref={google.box} style={{ display: showButton ? 'flex' : 'none', justifyContent: 'center', minHeight: showButton ? 44 : 0 }} aria-busy={google.busy} />
      {(status === 'checking' || (status === 'valid' && !google.ready)) && <p className="small muted" role="status" style={{ textAlign: 'center' }}>Checking your link…</p>}
      {google.busy && <p className="small muted" role="status" style={{ textAlign: 'center' }}>Creating your workspace…</p>}
      <p className="tiny muted mt">
        You become the HR lead of your own workspace: create campaigns, invite candidates and add HR members.
        Nobody else's data is visible to you, and yours is not visible to others. It is a demo with limits:
        3 campaigns, 10 candidates each, 25 calls, 5 team members and 30 invite emails a day.
      </p>
      <p className="tiny muted">Already have an account? <Link to="/login">Sign in</Link></p>
    </div>
  );
};

/** One sign-in page for everyone (reference: split layout, form left, preview right). */
export const LoginPage: React.FC = () => {
  const { inviteError } = useAppStore();
  const [params] = useSearchParams();
  const [who, setWho] = useState<Who>(params.get('as') === 'candidate' || inviteError ? 'candidate' : 'hr');
  const signupCode = params.get('signup');
  useEffect(() => { if (params.get('as') === 'candidate') setWho('candidate'); }, [params]);

  return (
    <div className="auth-split">
      <div className="auth-left dots">
        <div className="row">
          <Brand sub={false} />
          <div className="spacer"><ThemeToggle /></div>
        </div>
        <div className="auth-left-body">
          {signupCode ? (
            <div className="card auth-card">
              <h2>Create your HR workspace</h2>
              <p className="muted small mt-sm mb">Sign up with Google to run screening campaigns with your own team.</p>
              <HrSignUp code={signupCode} />
            </div>
          ) : (
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
          )}
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
