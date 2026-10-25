import React, { useEffect } from 'react';
import { LogOut } from 'lucide-react';
import { useAppStore } from './store/useAppStore';
import { LoginModal } from './components/auth/LoginModal';
import { CallSpikePage } from './pages/CallSpikePage';

// Phase A shell. The HR portal (batches, questions, results) and the candidate portal
// (resume upload, mic check, call) replace the placeholder in roadmap Phases D–H.
export const App: React.FC = () => {
  const { theme, currentUser, sessionChecked, initSession, logout } = useAppStore();

  useEffect(() => {
    document.documentElement.setAttribute('data-pd-theme', theme);
    initSession();
  }, []);

  if (!sessionChecked) return null;
  if (!currentUser) return <LoginModal />;

  const roleLabel = currentUser.role === 'superadmin' ? 'HR (super-admin)' : 'Candidate';

  return (
    <div className="lx-wrap">
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 24px', borderBottom: '1px solid var(--lx-border)' }}>
        <div style={{ fontWeight: 700, color: 'var(--lx-text)' }}>HR Screening Voice Agent</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--lx-muted)' }}>
          <span>{currentUser.email} · {roleLabel}</span>
          <button className="lx-restored-btn" onClick={logout} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <LogOut size={14} /> Sign out
          </button>
        </div>
      </header>

      <main className="lx-main" style={{ padding: 24, color: 'var(--lx-text)' }}>
        {currentUser.role === 'superadmin' ? (
          <CallSpikePage />
        ) : (
          <>
            <h2 style={{ marginTop: 0 }}>Signed in as {roleLabel}</h2>
            <p style={{ color: 'var(--lx-muted)' }}>The candidate portal (resume upload, mic check, screening call) is being built.</p>
          </>
        )}
      </main>
    </div>
  );
};

export default App;
