import React from 'react';
import { Link } from 'react-router-dom';
import { MailOpen } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { Brand, ThemeToggle } from '../components/layout/AppHeader';
import { ErrorNote } from '../components/ui/Modal';

// Shown to candidates without a session: they sign in only through the link HR gives them.
export const InviteRequiredPage: React.FC = () => {
  const { inviteError } = useAppStore();

  return (
    <div className="auth-screen">
      <div style={{ position: 'fixed', top: 14, right: 14 }}><ThemeToggle /></div>
      <div className="card auth-card">
        <Brand />
        <div className="empty-icon" style={{ margin: '0 0 12px' }}><MailOpen size={20} /></div>
        <h2>Open your invite link</h2>
        <div className="mt">
          <ErrorNote message={inviteError} />
        </div>
        <p className="muted" style={{ lineHeight: 1.6 }}>
          Candidates join with the personal link shared by the HR team. Each link works once. If yours no longer works, ask HR for a new one.
        </p>
        <p className="small mt">HR team? <Link to="/login">Sign in here</Link></p>
      </div>
    </div>
  );
};
