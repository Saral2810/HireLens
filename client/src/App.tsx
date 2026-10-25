import React, { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAppStore } from './store/useAppStore';
import { LoginModal } from './components/auth/LoginModal';
import { AppHeader } from './components/layout/AppHeader';
import { InviteRequiredPage } from './pages/InviteRequiredPage';
import { BatchesPage } from './pages/hr/BatchesPage';
import { BatchDetailPage } from './pages/hr/BatchDetailPage';
import { CandidateHomePage } from './pages/candidate/CandidateHomePage';

// Two portals: HR (super-admin) under /hr, candidates under /candidate.
// Each role is sent to its own area; the backend enforces the same split.
export const App: React.FC = () => {
  const { theme, currentUser, sessionChecked, inviteError, initSession } = useAppStore();
  const location = useLocation();

  useEffect(() => {
    document.documentElement.setAttribute('data-pd-theme', theme);
    initSession();
  }, []);

  if (!sessionChecked) return null;

  if (!currentUser) {
    const candidateArea = ['/candidate', '/invite'].some(p => location.pathname.startsWith(p));
    return candidateArea || inviteError ? <InviteRequiredPage /> : <LoginModal />;
  }

  const home = currentUser.role === 'superadmin' ? '/hr' : '/candidate';

  return (
    <div className="lx-wrap">
      <AppHeader />
      <main className="lx-main" style={{ padding: 24, color: 'var(--lx-text)' }}>
        <Routes>
          {currentUser.role === 'superadmin' && (
            <>
              <Route path="/hr" element={<BatchesPage />} />
              <Route path="/hr/batches/:batchId" element={<BatchDetailPage />} />
            </>
          )}
          {currentUser.role === 'candidate' && <Route path="/candidate/*" element={<CandidateHomePage />} />}
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
};

export default App;
