import React, { useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAppStore } from './store/useAppStore';
import { isHrRole } from './types';
import { AppHeader } from './components/layout/AppHeader';
import { LandingPage } from './pages/public/LandingPage';
import { LoginPage } from './pages/public/LoginPage';
import { JoinPage } from './pages/public/JoinPage';
import { DashboardPage } from './pages/hr/DashboardPage';
import { CampaignsPage } from './pages/hr/CampaignsPage';
import { NewCampaignPage } from './pages/hr/NewCampaignPage';
import { CampaignPage } from './pages/hr/CampaignPage';
import { TeamPage } from './pages/hr/TeamPage';
import { CandidateHomePage } from './pages/candidate/CandidateHomePage';

// Three roles, three areas: Admin and Recruiter under /hr, candidates under /candidate.
// The backend enforces the same split (and recruiters only reach their own campaigns).
export const App: React.FC = () => {
  const { currentUser, sessionChecked, initSession } = useAppStore();
  const location = useLocation();

  useEffect(() => {
    initSession();
  }, []);

  if (!sessionChecked) return null;

  // The link from an invite email works whoever is signed in on this browser: it signs in as the candidate.
  if (location.pathname === '/join') return <JoinPage />;

  if (!currentUser) {
    const wantsCandidate = location.pathname.startsWith('/candidate') || location.pathname.startsWith('/auth') || location.pathname.startsWith('/invite');
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to={wantsCandidate ? '/login?as=candidate' : location.pathname.startsWith('/hr') ? '/login' : '/'} replace />} />
      </Routes>
    );
  }

  const hr = isHrRole(currentUser.role);
  const home = hr ? '/hr' : '/candidate';

  return (
    <div className="app">
      <AppHeader />
      <main className="container">
        <Routes>
          {hr && (
            <>
              <Route path="/hr" element={<DashboardPage />} />
              <Route path="/hr/campaigns" element={<CampaignsPage />} />
              <Route path="/hr/campaigns/new" element={<NewCampaignPage />} />
              <Route path="/hr/campaigns/:campaignId" element={<CampaignPage />} />
              {currentUser.role === 'superadmin' && <Route path="/hr/team" element={<TeamPage />} />}
            </>
          )}
          {!hr && <Route path="/candidate/*" element={<CandidateHomePage />} />}
          <Route path="*" element={<Navigate to={home} replace />} />
        </Routes>
      </main>
    </div>
  );
};

export default App;
