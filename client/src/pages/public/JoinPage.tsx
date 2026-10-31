import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { LogIn } from 'lucide-react';
import { api } from '../../services/api';
import { Brand } from '../../components/layout/AppHeader';
import { ErrorNote } from '../../components/ui/Modal';

/**
 * /join?t=<token> — the candidate's personal link (invite email, or copied by HR). The server checks
 * the token and signs the candidate in; they land on their screening dashboard. The browser never
 * leaves this site.
 */
export const JoinPage: React.FC = () => {
  const [params] = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // React StrictMode runs effects twice in development; the sign-in link must be made once.
    if (started.current) return;
    started.current = true;
    const token = params.get('t');
    if (!token) {
      setError('This link is incomplete. Open the full link from your invite email.');
      return;
    }
    api.joinScreening(token)
      .then(() => window.location.replace('/candidate'))
      .catch((err: Error) => setError(err.message));
  }, [params]);

  return (
    <div className="dots" style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card auth-card" style={{ maxWidth: 420, width: '100%' }}>
        <div className="mb"><Brand sub={false} /></div>
        {error ? (
          <>
            <h2>We could not open your screening</h2>
            <div className="mt"><ErrorNote message={error} /></div>
            <Link to="/login?as=candidate" className="btn mt"><LogIn size={15} /> Sign in another way</Link>
          </>
        ) : (
          <>
            <h2>Opening your screening…</h2>
            <p className="muted small mt-sm" role="status">Signing you in. This takes a few seconds.</p>
          </>
        )}
      </div>
    </div>
  );
};
