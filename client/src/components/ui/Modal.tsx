import React, { useEffect } from 'react';
import { X } from 'lucide-react';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: number;
}

/** Centred dialog with a dimmed backdrop. Escape or the × button closes it. */
export const Modal: React.FC<ModalProps> = ({ title, onClose, children, maxWidth = 520 }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, zIndex: 9999, background: 'rgba(4, 7, 16, 0.75)' }}
    >
      <div className="lx-restored-box" style={{ width: '100%', maxWidth, maxHeight: '90vh', overflowY: 'auto', padding: '22px 22px', boxSizing: 'border-box', color: 'var(--lx-text)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ margin: 0, fontSize: 17 }}>{title}</h3>
          <button className="lx-restored-btn" onClick={onClose} aria-label="Close" style={{ padding: '4px 8px' }}><X size={14} /></button>
        </div>
        {children}
      </div>
    </div>
  );
};

/** Labelled form field used across HR forms. */
export const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
  <label style={{ display: 'block', marginBottom: 12 }}>
    <span style={{ display: 'block', fontSize: 11, fontWeight: 600, color: 'var(--lx-muted)', marginBottom: 5, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
    {children}
    {hint && <span style={{ display: 'block', fontSize: 12, color: 'var(--lx-muted)', marginTop: 4 }}>{hint}</span>}
  </label>
);

export const ErrorNote: React.FC<{ message: string | null }> = ({ message }) =>
  message ? (
    <div role="alert" style={{ padding: '9px 12px', background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 8, color: '#fca5a5', fontSize: 13, marginBottom: 12 }}>
      {message}
    </div>
  ) : null;
