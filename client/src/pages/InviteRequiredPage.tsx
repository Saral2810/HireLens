import React from 'react';
import { Link } from 'react-router-dom';
import { MailOpen, AlertCircle } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

// Shown to candidates without a session: they sign in only through the link HR gives them.
export const InviteRequiredPage: React.FC = () => {
  const { inviteError } = useAppStore();

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}>
      <div className="lx-restored-box" style={{ width: '100%', maxWidth: 440, padding: '32px 28px', boxSizing: 'border-box', color: 'var(--lx-text)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <MailOpen size={22} />
          <h2 style={{ margin: 0, fontSize: 18 }}>Open your invite link</h2>
        </div>
        {inviteError && (
          <div style={{ padding: '10px 12px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: '#fca5a5', fontSize: 13, marginBottom: 14, display: 'flex', gap: 6 }}>
            <AlertCircle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
            {inviteError}
          </div>
        )}
        <p style={{ color: 'var(--lx-muted)', fontSize: 14, lineHeight: 1.5 }}>
          Candidates sign in with the personal link shared by the HR team. Each link works once; if yours no longer works, ask HR for a new one.
        </p>
        <p style={{ fontSize: 13, marginBottom: 0 }}>
          HR team? <Link to="/login" style={{ color: 'var(--lx-accent, #818cf8)' }}>Sign in here</Link>
        </p>
      </div>
    </div>
  );
};
