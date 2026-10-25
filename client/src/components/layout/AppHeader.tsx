import React from 'react';
import { LogOut } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../store/useAppStore';

export const AppHeader: React.FC = () => {
  const { currentUser, logout } = useAppStore();
  const navigate = useNavigate();
  if (!currentUser) return null;

  const roleLabel = currentUser.role === 'superadmin' ? 'HR' : 'Candidate';
  const signOut = () => {
    logout();
    navigate(currentUser.role === 'superadmin' ? '/login' : '/invite', { replace: true });
  };

  return (
    <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', padding: '14px 24px', borderBottom: '1px solid var(--lx-border)' }}>
      <div style={{ fontWeight: 700, color: 'var(--lx-text)' }}>HR Screening Voice Agent</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 13, color: 'var(--lx-muted)' }}>
        <span>{currentUser.name || currentUser.email} · {roleLabel}</span>
        <button className="lx-restored-btn" onClick={signOut} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <LogOut size={14} /> Sign out
        </button>
      </div>
    </header>
  );
};
