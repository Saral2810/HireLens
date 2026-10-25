import React, { useState } from 'react';
import { LogIn } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/api';
import { Brand, ThemeToggle } from '../layout/AppHeader';
import { ErrorNote, Field } from '../ui/Modal';

/** HR sign-in screen (candidates sign in through their invite link instead). */
export const LoginModal: React.FC = () => {
  const { setCurrentUser } = useAppStore();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await api.login(email, password);
      if (res.user) setCurrentUser(res.user);
    } catch (err: any) {
      setError(err.message || 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div style={{ position: 'fixed', top: 14, right: 14 }}><ThemeToggle /></div>
      <div className="card auth-card">
        <Brand />
        <h2>Sign in</h2>
        <p className="muted mt-sm mb">For the HR team. Candidates join with the link HR sends them.</p>
        <ErrorNote message={error} />
        <form onSubmit={handleLogin}>
          <Field label="Email">
            <input type="email" required autoComplete="username" className="input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" />
          </Field>
          <Field label="Password">
            <input type="password" required autoComplete="current-password" className="input" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <button type="submit" className="btn btn-primary btn-lg btn-block mt-sm" disabled={loading}>
            <LogIn size={16} /> {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
};
