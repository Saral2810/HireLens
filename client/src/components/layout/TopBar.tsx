import React, { useState, useRef, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { 
  ChevronsUpDown, 
  Sun, 
  Moon, 
  BookOpen, 
  LogOut, 
  Bell, 
  ShieldCheck, 
  Settings,
  Database
} from 'lucide-react';

export const TopBar: React.FC = () => {
  const {
    theme,
    setTheme,
    activeTenant,
    setActiveTenant,
    tenantsList,
    currentUser,
    isSuperAdmin,
    setActivePage,
    notifications,
    clearNotifications,
    logout
  } = useAppStore();

  const [isTenantMenuOpen, setIsTenantMenuOpen] = useState(false);
  const [isNotifOpen, setIsNotifOpen] = useState(false);
  const tenantMenuRef = useRef<HTMLDivElement>(null);
  const notifRef = useRef<HTMLDivElement>(null);

  // Close dropdowns on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (tenantMenuRef.current && !tenantMenuRef.current.contains(e.target as Node)) {
        setIsTenantMenuOpen(false);
      }
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setIsNotifOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentTenantObj = tenantsList.find(t => (t.id || (t as any).tenant_id) === activeTenant);
  const displayTenantName = currentTenantObj?.name || activeTenant;
  const unreadCount = notifications.filter(n => !n.read).length;

  return (
    <header className="lx-topbar">
      {/* Brand Logo */}
      <div className="lx-logo" onClick={() => setActivePage('home')} style={{ cursor: 'pointer' }}>
        <div className="lx-logo-mark">G</div>
        <div>
          <strong style={{ fontSize: '15px', letterSpacing: '-0.02em' }}>Gnani.ai</strong>
          <span style={{ fontSize: '9.5px', color: 'var(--lx-muted)', display: 'block', marginTop: '-2px', fontWeight: 500 }}>
            Voice Campaign Console
          </span>
        </div>
      </div>

      <div style={{ width: '1px', height: '28px', background: 'var(--lx-border)', flexShrink: 0 }}></div>

      {/* Tenant / Workspace Selector */}
      <div className="lx-tenant-switcher" ref={tenantMenuRef} style={{ position: 'relative' }}>
        <div 
          className="lx-tenant-pill" 
          onClick={() => setIsTenantMenuOpen(!isTenantMenuOpen)}
        >
          <div className="lx-tenant-dot" style={{ background: 'var(--lx-green)', boxShadow: '0 0 6px var(--lx-green)' }}></div>
          <div className="lx-tenant-info">
            <span className="lx-tenant-label">Workspace</span>
            <span className="lx-tenant-name">{displayTenantName}</span>
          </div>
          <ChevronsUpDown size={14} className="lx-tenant-icon" />
        </div>

        {isTenantMenuOpen && (
          <div className="lx-tenant-menu" style={{ display: 'block' }}>
            <div className="lx-tenant-menu-header">Select Client Workspace</div>
            <div className="lx-tenant-list">
              {tenantsList.map(t => (
                <div 
                  key={t.id || (t as any).tenant_id} 
                  className={`lx-tenant-item ${(t.id || (t as any).tenant_id) === activeTenant ? 'active' : ''}`}
                  onClick={() => {
                    setActiveTenant(t.id || (t as any).tenant_id);
                    setIsTenantMenuOpen(false);
                  }}
                >
                  <div className="lx-tenant-dot" style={{ width: 6, height: 6, background: (t.id || (t as any).tenant_id) === activeTenant ? 'var(--lx-accent)' : 'var(--lx-muted)' }}></div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600 }}>{t.name}</div>
                    <div style={{ fontSize: '10.5px', color: 'var(--lx-muted)' }}>ID: {t.id || (t as any).tenant_id}</div>
                  </div>
                </div>
              ))}
            </div>
            {isSuperAdmin && (
              <div 
                className="lx-tenant-menu-footer" 
                onClick={() => {
                  setActivePage('settings');
                  setIsTenantMenuOpen(false);
                }}
              >
                <Settings size={14} style={{ display: 'inline', marginRight: 6 }} /> Manage Workspaces
              </div>
            )}
          </div>
        )}
      </div>

      {/* Server Status Badge */}
      <span className="lx-server-status" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Database size={12} color="var(--lx-green)" />
        <span>Connected</span>
      </span>

      {/* Platform Mode Badge */}
      {isSuperAdmin ? (
        <div className="lx-mode-badge lx-mode-badge--superadmin" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <ShieldCheck size={14} />
          <span>Super-Admin Mode</span>
        </div>
      ) : (
        <div className="lx-mode-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <span>Tenant Operator</span>
        </div>
      )}

      {/* Top Right Controls */}
      <div className="lx-topbar-right" style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        {/* Theme Toggle */}
        <div className="pd-toggle" style={{ display: 'inline-flex' }}>
          <button 
            type="button"
            data-theme="light" 
            aria-label="Light" 
            className={theme === 'light' ? 'active' : ''}
            onClick={() => setTheme('light')}
          >
            <Sun size={14} />
          </button>
          <button 
            type="button"
            data-theme="dark" 
            aria-label="Dark" 
            className={theme === 'dark' ? 'active' : ''}
            onClick={() => setTheme('dark')}
          >
            <Moon size={14} />
          </button>
        </div>

        {/* Docs & Glossary */}
        <button 
          type="button"
          className="lx-help-nav-btn" 
          title="Docs & Glossary" 
          onClick={() => setActivePage('help')}
        >
          <BookOpen size={14} />
          <span className="lx-help-nav-text">Docs</span>
          <span className="lx-kbd-hint">?</span>
        </button>

        {/* Notifications Bell */}
        <div 
          className="lx-notification-wrapper" 
          ref={notifRef}
          style={{ position: 'relative' }}
        >
          <div 
            onClick={() => setIsNotifOpen(!isNotifOpen)}
            style={{ 
              cursor: 'pointer', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center', 
              width: 34, 
              height: 34, 
              borderRadius: '50%', 
              background: 'var(--lx-card)', 
              border: '1px solid var(--lx-border)' 
            }}
          >
            <Bell size={16} />
            {unreadCount > 0 && (
              <span style={{ 
                position: 'absolute', 
                top: 7, 
                right: 7, 
                background: 'var(--lx-red)', 
                width: 7, 
                height: 7, 
                borderRadius: '50%', 
                boxShadow: '0 0 0 2px var(--lx-card)' 
              }}></span>
            )}
          </div>

          {isNotifOpen && (
            <div style={{ 
              position: 'absolute', 
              top: 42, 
              right: 0, 
              width: 320, 
              background: 'var(--lx-surface)', 
              border: '1px solid var(--lx-border2)', 
              borderRadius: 12, 
              boxShadow: '0 10px 30px rgba(0,0,0,0.5)', 
              zIndex: 1000, 
              overflow: 'hidden' 
            }}>
              <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--lx-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong style={{ fontSize: 13 }}>Notifications</strong>
                <span 
                  style={{ fontSize: 11.5, color: 'var(--lx-muted)', cursor: 'pointer' }}
                  onClick={clearNotifications}
                >
                  Clear All
                </span>
              </div>
              <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                {notifications.length === 0 ? (
                  <div style={{ padding: 24, textAlign: 'center', color: 'var(--lx-muted)', fontSize: 12 }}>
                    No new notifications
                  </div>
                ) : (
                  notifications.map(n => (
                    <div key={n.id} style={{ padding: '10px 14px', borderBottom: '1px solid var(--lx-border)', fontSize: 12 }}>
                      <div style={{ fontWeight: 600, color: 'var(--lx-text)' }}>{n.title}</div>
                      <div style={{ color: 'var(--lx-muted)', marginTop: 2 }}>{n.message}</div>
                      <div style={{ fontSize: 10, color: 'var(--lx-muted)', marginTop: 4 }}>{n.timestamp}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>

        {/* User Profile Avatar */}
        <div 
          className="lx-avatar" 
          title={currentUser?.email || 'User'} 
          style={{ cursor: 'pointer' }}
          onClick={() => setActivePage('settings')}
        >
          {currentUser?.email ? currentUser.email.substring(0, 2).toUpperCase() : 'G'}
        </div>

        {/* Sign Out */}
        <button 
          type="button"
          className="lx-logout-btn" 
          title="Sign Out" 
          onClick={logout}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px' }}
        >
          <LogOut size={14} />
          <span className="lx-logout-text">Sign Out</span>
        </button>
      </div>
    </header>
  );
};
