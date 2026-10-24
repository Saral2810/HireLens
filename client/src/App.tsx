import React, { useEffect } from 'react';
import { useAppStore } from './store/useAppStore';
import { TopBar } from './components/layout/TopBar';
import { Sidebar } from './components/layout/Sidebar';
import { DashboardPage } from './pages/DashboardPage';
import { LeadsPage } from './pages/LeadsPage';
import { CampaignsPage } from './pages/CampaignsPage';
import { LiveMonitorPage } from './pages/LiveMonitorPage';
import { AgentsPage } from './pages/AgentsPage';
import { IntegrationsPage } from './pages/IntegrationsPage';
import { SchedulerPage } from './pages/SchedulerPage';
import { SuperAdminPage } from './pages/SuperAdminPage';
import { DncPage } from './pages/DncPage';
import { HelpPage } from './pages/HelpPage';

// Modals
import { LeadDetailsModal } from './components/modals/LeadDetailsModal';
import { SwitchProviderModal } from './components/modals/SwitchProviderModal';
import { CreateCampaignModal } from './components/modals/CreateCampaignModal';
import { LoginModal } from './components/auth/LoginModal';

export const App: React.FC = () => {
  const { activePage, setActivePage, theme, initSession } = useAppStore();

  useEffect(() => {
    initSession();

    // Mount theme on document root
    document.documentElement.setAttribute('data-pd-theme', theme);

    // Keyboard shortcut handler
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === '?' && !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) {
        setActivePage('help');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const renderPage = () => {
    switch (activePage) {
      case 'home':
        return <DashboardPage />;
      case 'leads':
        return <LeadsPage />;
      case 'campaigns':
        return <CampaignsPage />;
      case 'monitor':
        return <LiveMonitorPage />;
      case 'agents':
        return <AgentsPage />;
      case 'crm':
      case 'integrations':
        return <IntegrationsPage />;
      case 'scheduler':
        return <SchedulerPage />;
      case 'settings':
        return <SuperAdminPage />;
      case 'dnc':
        return <DncPage />;
      case 'help':
        return <HelpPage />;
      default:
        return <DashboardPage />;
    }
  };

  return (
    <div className="lx-wrap">
      {/* Top Navigation */}
      <TopBar />

      {/* Main Body */}
      <div className="lx-body" style={{ display: 'flex', flex: 1, overflow: 'hidden' }}>
        {/* Sidebar */}
        <Sidebar />

        {/* Content View */}
        <main className="lx-main" style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
          {renderPage()}
        </main>
      </div>

      {/* Global Modals */}
      <LeadDetailsModal />
      <SwitchProviderModal />
      <CreateCampaignModal />
      <LoginModal />
    </div>
  );
};

export default App;
