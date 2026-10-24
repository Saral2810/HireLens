import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { PageType } from '../../types';
import {
  LayoutDashboard,
  Target,
  Zap,
  Users,
  Link2,
  CalendarClock,
  Plug,
  Settings,
  Radio,
  PhoneOff
} from 'lucide-react';

export const Sidebar: React.FC = () => {
  const { activePage, setActivePage, isSuperAdmin } = useAppStore();

  const navItems: Array<{ page: PageType; label: string; icon: React.ReactNode; badge?: React.ReactNode }> = [
    { page: 'home', label: 'Dashboard', icon: <LayoutDashboard size={16} /> },
    { page: 'campaigns', label: 'Campaigns', icon: <Target size={16} /> },
    { 
      page: 'leads', 
      label: 'Lead Intelligence', 
      icon: <Zap size={16} />
    },
    { page: 'agents', label: 'Voice Agents', icon: <Users size={16} /> },
    { page: 'crm', label: 'CRM Sync', icon: <Link2 size={16} /> },
    { page: 'scheduler', label: 'Scheduler', icon: <CalendarClock size={16} /> },
    { page: 'integrations', label: 'API & Integrations', icon: <Plug size={16} /> },
    { 
      page: 'settings', 
      label: isSuperAdmin ? 'Super Admin' : 'Workspace Settings', 
      icon: <Settings size={16} /> 
    },
  ];

  const realtimeItems: Array<{ page: PageType; label: string; icon: React.ReactNode; badge?: React.ReactNode }> = [
    { 
      page: 'monitor', 
      label: 'Live Monitor', 
      icon: <Radio size={16} />,
      badge: (
        <span 
          className="count badge-green" 
          style={{ 
            background: 'rgba(46, 204, 138, 0.18)', 
            color: 'var(--lx-green)',
            animation: 'tenantPulse 2s infinite'
          }}
        >
          ● Live
        </span>
      )
    },
    { page: 'dnc', label: 'DNC Registry', icon: <PhoneOff size={16} /> },
  ];

  return (
    <aside className="lx-sidebar" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="lx-sidebar-section">Main Operations</div>
      {navItems.map((item) => (
        <div
          key={item.page}
          className={`lx-sidebar-item ${activePage === item.page ? 'active' : ''}`}
          onClick={() => setActivePage(item.page)}
        >
          <span className="lx-icon">{item.icon}</span>
          <span>{item.label}</span>
          {item.badge}
        </div>
      ))}

      <div className="lx-sidebar-section" style={{ marginTop: 14 }}>Real-Time</div>
      {realtimeItems.map((item) => (
        <div
          key={item.page}
          className={`lx-sidebar-item ${activePage === item.page ? 'active' : ''}`}
          onClick={() => setActivePage(item.page)}
        >
          <span className="lx-icon">{item.icon}</span>
          <span>{item.label}</span>
          {item.badge}
        </div>
      ))}

      <div style={{ flex: 1 }}></div>

      {/* Brand Footer — replace with your own logo */}
      <div 
        style={{ 
          padding: '24px 12px 16px 0px', 
          display: 'flex', 
          flexDirection: 'column', 
          alignItems: 'flex-start', 
          justifyContent: 'center', 
          marginTop: 'auto', 
          borderTop: '1px solid var(--lx-border-soft)' 
        }}
      >
        <strong style={{ fontSize: 13, color: 'var(--lx-text)' }}>Gnani.ai</strong>
        <span style={{ fontSize: '10px', color: 'var(--lx-muted)', marginTop: 4 }}>
          Voice Intelligence Engine
        </span>
      </div>
    </aside>
  );
};
