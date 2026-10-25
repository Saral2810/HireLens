import React from 'react';
import { AudioLines, FolderKanban, LayoutDashboard, LogOut, Moon, Sun, Users } from 'lucide-react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useAppStore } from '../../store/useAppStore';
import { isHrRole } from '../../types';

export const ROLE_LABELS = { superadmin: 'Admin', recruiter: 'Recruiter', candidate: 'Candidate' } as const;

/** Logo mark used in the header and on public pages. */
export const Brand: React.FC<{ to?: string; sub?: boolean }> = ({ to = '/', sub = true }) => (
  <Link to={to} className="brand">
    <span className="brand-mark"><AudioLines size={16} /></span>
    <span>
      HR Screening
      {sub && <span className="brand-sub">voice agent · gnani</span>}
    </span>
  </Link>
);

export const ThemeToggle: React.FC = () => {
  const { theme, setTheme } = useAppStore();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="btn btn-ghost btn-icon" onClick={() => setTheme(next)} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
};

const initials = (text: string) => text.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map(w => w[0]!.toUpperCase()).join('');

export const AppHeader: React.FC = () => {
  const { currentUser, logout } = useAppStore();
  const navigate = useNavigate();
  if (!currentUser) return null;

  const hr = isHrRole(currentUser.role);
  const display = currentUser.name || currentUser.email;
  const signOut = () => {
    logout();
    navigate('/login', { replace: true });
  };
  const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : undefined);

  return (
    <header className="topbar">
      <Brand to={hr ? '/hr' : '/candidate'} />
      {hr && (
        <nav className="nav" aria-label="Main">
          <NavLink to="/hr" end className={navClass}><LayoutDashboard size={15} /><span>Dashboard</span></NavLink>
          <NavLink to="/hr/campaigns" className={navClass}><FolderKanban size={15} /><span>Campaigns</span></NavLink>
          {currentUser.role === 'superadmin' && <NavLink to="/hr/team" className={navClass}><Users size={15} /><span>Team</span></NavLink>}
        </nav>
      )}
      <div className="row spacer">
        <ThemeToggle />
        <div className="user-chip">
          <span className="avatar" aria-hidden="true">{initials(display)}</span>
          <span className="user-name">
            <span className="strong" style={{ display: 'block', lineHeight: 1.2 }}>{display}</span>
            <span className="role-tag">{ROLE_LABELS[currentUser.role]}</span>
          </span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={signOut} aria-label="Sign out" title="Sign out">
          <LogOut size={15} /><span className="user-name">Sign out</span>
        </button>
      </div>
    </header>
  );
};
