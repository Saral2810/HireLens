import React, { useEffect, useState } from 'react';
import { Check, Link2, Mail, Pencil, RotateCcw, Trash2, UserPlus, Users } from 'lucide-react';
import { api } from '../../services/api';
import { CandidateRow } from '../../types';
import { EmptyState, ErrorNote } from '../ui/Modal';
import { AddCandidatesModal } from './AddCandidatesModal';
import { EditCandidateModal } from './EditCandidateModal';
import { StatusBadge } from './StatusBadge';

interface Props {
  batchId: string;
  candidates: CandidateRow[];
  live: boolean;
  /** The server can send invite emails (SMTP set up). */
  emailConfigured: boolean;
  onReload: () => Promise<void>;
}

/**
 * Candidates in a campaign: add (Excel, CSV or typed), remove before they start, track status,
 * allow a retake, see who got the invite email (and send it again), or copy a one-time invite link.
 */
export const CandidatesPanel: React.FC<Props> = ({ batchId, candidates, live, emailConfigured, onReload }) => {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CandidateRow | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Shown when the browser refuses clipboard access, so HR can copy the link by hand.
  const [manualLink, setManualLink] = useState<{ name: string; link: string } | null>(null);

  // Invite emails go out in the background after Run; refresh until each one is sent or failed (up to 2 minutes).
  const queued = (c: CandidateRow) => live && emailConfigured && c.status !== 'completed' && !c.invite_email_sent_at && !c.invite_email_error;
  const anyQueued = candidates.some(queued);
  const [pollUntil] = useState(() => Date.now() + 2 * 60 * 1000);
  useEffect(() => {
    if (!anyQueued || Date.now() > pollUntil) return;
    const timer = setTimeout(() => { onReload(); }, 4000);
    return () => clearTimeout(timer);
  }, [anyQueued, candidates, onReload, pollUntil]);

  const run = async (id: string, action: () => Promise<unknown>, message?: string) => {
    setBusyId(id);
    setError(null);
    try {
      await action();
      if (message) setNotice(message);
      await onReload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = (c: CandidateRow) => {
    if (window.confirm(`Remove ${c.name} (${c.email}) from this campaign?`)) run(c.id, () => api.deleteCandidate(c.id));
  };
  const retake = (c: CandidateRow) => {
    if (window.confirm(`Let ${c.name} take the call again? Their earlier answers stay saved.`)) {
      run(c.id, () => api.allowRetake(c.id), `${c.name} can take the call again from their dashboard.`);
    }
  };
  const sendEmail = (c: CandidateRow) => run(c.id, () => api.sendInviteEmail(c.id), `Invite email sent to ${c.email}.`);

  const emailCell = (c: CandidateRow) => {
    if (c.invite_email_sent_at) {
      const when = new Date(c.invite_email_sent_at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
      return <span className="small muted" title={`Invite email sent ${when}`}><Check size={13} /> Sent {when}</span>;
    }
    if (c.invite_email_error) return <span className="small" style={{ color: 'var(--danger, #b00020)' }} title={c.invite_email_error}>Failed: {c.invite_email_error.slice(0, 60)}</span>;
    if (c.status === 'completed') return <span className="small muted">—</span>;
    if (!emailConfigured) return <span className="small muted" title="Add SMTP settings to .env to email invites">Email not set up</span>;
    return <span className="small muted">{live ? 'Sending…' : 'Sent when you run the campaign'}</span>;
  };

  const copyInvite = async (c: CandidateRow) => {
    setBusyId(c.id);
    setError(null);
    setManualLink(null);
    try {
      const { invite_link } = await api.createInviteLink(c.id);
      try {
        await navigator.clipboard.writeText(invite_link);
        setCopiedId(c.id);
        setTimeout(() => setCopiedId(id => (id === c.id ? null : id)), 2000);
        setNotice(`Invite link for ${c.name} copied. It signs them in straight away and works once.`);
      } catch {
        setNotice(null);
        setManualLink({ name: c.name, link: invite_link });
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="stack">
      <div className="row-wrap">
        <p className="muted small grow">{emailConfigured
          ? 'When the campaign runs, each candidate is emailed a personal link that opens their screening. You can also send the email again or copy the link yourself.'
          : "Invite emails are not set up yet (SMTP settings in .env). Until then, copy each candidate's invite link and send it yourself."}</p>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><UserPlus size={15} /> Add candidates</button>
      </div>
      <ErrorNote message={error} />
      {notice && <div role="status" className="alert" style={{ marginBottom: 0 }}><Check size={15} /><span>{notice}</span></div>}
      {manualLink && (
        <div className="card card-pad">
          <p className="small mb-sm">Copy this invite link for {manualLink.name}. It works once.</p>
          <input className="input mono" readOnly value={manualLink.link} onFocus={e => e.target.select()} aria-label={`Invite link for ${manualLink.name}`} style={{ fontSize: 13 }} />
        </div>
      )}

      <div className="card">
        {candidates.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="No candidates yet">
            Upload an Excel or CSV file with Name and Email columns, or add people by hand.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Status</th><th>Invite email</th><th className="actions"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {candidates.map(c => (
                  <tr key={c.id}>
                    <td className="strong">{c.name}</td>
                    <td className="muted">{c.email}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>{emailCell(c)}</td>
                    <td className="actions">
                      <div className="btn-group">
                        {c.status !== 'completed' && live && emailConfigured && !queued(c) && (
                          <button className="btn btn-sm" onClick={() => sendEmail(c)} disabled={busyId !== null} title="Email this candidate their personal link">
                            <Mail size={14} /> {c.invite_email_sent_at ? 'Resend email' : 'Send email'}
                          </button>
                        )}
                        {c.status !== 'completed' && (
                          <button className="btn btn-sm" onClick={() => copyInvite(c)} disabled={busyId !== null || !live}
                            title={live ? 'Copy a one-time sign-in link for this candidate' : 'Run the campaign first'}>
                            {copiedId === c.id ? <Check size={14} /> : <Link2 size={14} />} {copiedId === c.id ? 'Copied' : 'Copy invite link'}
                          </button>
                        )}
                        {c.status === 'failed' && (
                          <button className="btn btn-sm" onClick={() => retake(c)} disabled={busyId !== null} title="Let this candidate take the call again">
                            <RotateCcw size={14} /> Allow retake
                          </button>
                        )}
                        <button className="btn btn-ghost btn-icon" onClick={() => setEditing(c)} disabled={busyId !== null} aria-label={`Edit ${c.name}`} title="Edit name or email">
                          <Pencil size={15} />
                        </button>
                        {c.status === 'invited' && (
                          <button className="btn btn-ghost btn-icon" onClick={() => remove(c)} disabled={busyId !== null} aria-label={`Remove ${c.name}`} title="Remove">
                            <Trash2 size={15} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <EditCandidateModal
          candidate={editing}
          onClose={() => setEditing(null)}
          onSaved={async ({ emailChanged, emails }) => {
            const name = editing.name;
            setEditing(null);
            setNotice(emailChanged
              ? `Email for ${name} updated; the old link no longer works.${emails.queued ? ' A new invite email is on its way.' : ''}`
              : `Saved ${name}.`);
            await onReload();
          }}
        />
      )}
      {adding && (
        <AddCandidatesModal
          batchId={batchId}
          existingCount={candidates.length}
          existingEmails={candidates.map(c => c.email)}
          onClose={() => setAdding(false)}
          onAdded={async ({ added, skipped_existing, emails }) => {
            setAdding(false);
            setNotice(`Added ${added} candidate${added === 1 ? '' : 's'}${skipped_existing ? `; ${skipped_existing} already in the campaign were skipped` : ''}.${emails?.queued ? ` Sending ${emails.queued} invite email${emails.queued === 1 ? '' : 's'}.` : ''}`);
            await onReload();
          }}
        />
      )}
    </div>
  );
};
