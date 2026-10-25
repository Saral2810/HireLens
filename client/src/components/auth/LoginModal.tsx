import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/api';
import { LogIn, AlertCircle } from 'lucide-react';

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
      if (res.user) {
        setCurrentUser(res.user);
      }
    } catch (err: any) {
      setError(err.message || 'Invalid email or password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="lx-restored-modal show" 
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 99999, background: 'rgba(4, 7, 16, 0.88)', backdropFilter: 'blur(12px)' }}
    >
      <div className="lx-restored-box" style={{ width: '100%', maxWidth: 420, padding: '32px 28px', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 24 }}>
          <div style={{ 
            width: 42, 
            height: 42, 
            borderRadius: 10, 
            background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center', 
            color: '#fff', 
            fontWeight: 800, 
            fontSize: 16, 
            boxShadow: '0 4px 14px rgba(99,102,241,0.35)' 
          }}>
            HR
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--lx-text)', letterSpacing: '-0.01em' }}>
              Sign in to HR Screening
            </div>
            <div style={{ fontSize: 12, color: 'var(--lx-muted)', marginTop: 2 }}>
              Voice screening calls with Gnani Prisma and Timbre
            </div>
          </div>
        </div>

        {error && (
          <div style={{ padding: '10px 12px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: '#fca5a5', fontSize: 12, marginBottom: 14, display: 'flex', alignItems: 'center', gap: 6 }}>
            <AlertCircle size={14} />
            {error}
          </div>
        )}

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: 14 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--lx-muted)', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Email Address
            </label>
            <input 
              type="email" 
              required
              className="lx-input"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
            />
          </div>

          <div style={{ marginBottom: 18 }}>
            <label style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--lx-muted)', marginBottom: 6, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Password
            </label>
            <input 
              type="password" 
              required
              className="lx-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <button 
            type="submit" 
            className="lx-restored-btn primary"
            style={{ width: '100%', height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, fontSize: 14 }}
            disabled={loading}
          >
            <LogIn size={15} />
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>
      </div>
    </div>
  );
};
