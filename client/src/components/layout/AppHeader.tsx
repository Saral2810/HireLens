import React from 'react';
import { AudioLines, LogOut, Moon, Sun } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { useAppStore } from '../../store/useAppStore';

/** Logo mark used in the header and on the sign-in screens. */
export const Brand: React.FC<{ to?: string }> = ({ to }) => {
  const inner = (
    <>
      <span className="brand-mark"><AudioLines size={17} /></span>
      <span>
        HR Screening
        <span className="brand-sub">Voice agent · Gnani</span>
      </span>
    </>
  );
  return to ? <Link to={to} className="brand">{inner}</Link> : <div className="brand">{inner}</div>;
};

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

  const isHr = currentUser.role === 'superadmin';
  const display = currentUser.name || currentUser.email;
  const signOut = () => {
    logout();
    navigate(isHr ? '/login' : '/invite', { replace: true });
  };

  return (
    <header className="topbar">
      <Brand to={isHr ? '/hr' : '/candidate'} />
      <div className="row spacer">
        <ThemeToggle />
        <div className="user-chip">
          <span className="avatar" aria-hidden="true">{initials(display)}</span>
          <span className="user-name">
            <span className="strong" style={{ display: 'block', lineHeight: 1.2 }}>{display}</span>
            <span className="tiny muted">{isHr ? 'HR team' : 'Candidate'}</span>
          </span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={signOut} aria-label="Sign out" title="Sign out">
          <LogOut size={15} /><span className="user-name">Sign out</span>
        </button>
      </div>
    </header>
  );
};
