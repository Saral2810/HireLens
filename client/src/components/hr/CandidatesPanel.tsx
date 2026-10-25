import React, { useState } from 'react';
import { CheckCircle2, Copy, Link2, RotateCcw, Trash2, UserPlus, Users } from 'lucide-react';
import { api } from '../../services/api';
import { CandidateRow, InviteLinkResult } from '../../types';
import { EmptyState, ErrorNote, Modal } from '../ui/Modal';
import { AddCandidatesModal } from './AddCandidatesModal';
import { StatusBadge } from './StatusBadge';

interface Props {
  batchId: string;
  candidates: CandidateRow[];
  onReload: () => Promise<void>;
}

async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** Candidates in a batch: add, remove, track status and hand out one-time invite links. */
export const CandidatesPanel: React.FC<Props> = ({ batchId, candidates, onReload }) => {
  const [adding, setAdding] = useState(false);
  const [links, setLinks] = useState<InviteLinkResult[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const copyLinkFor = async (c: CandidateRow) => {
    setBusyId(c.id);
    setError(null);
    try {
      const { invite_link } = await api.createInviteLink(c.id);
      setNotice(await copy(invite_link)
        ? `Invite link for ${c.name} copied. Send it to them. It works once.`
        : `Invite link for ${c.name}: ${invite_link}`);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const linksForAll = async () => {
    setBusyId('all');
    setError(null);
    try {
      setLinks((await api.createInviteLinks(batchId)).links);
      await onReload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (c: CandidateRow) => {
    if (!window.confirm(`Remove ${c.name} (${c.email}) from this batch?`)) return;
    setBusyId(c.id);
    setError(null);
    try {
      await api.deleteCandidate(c.id);
      await onReload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const retake = async (c: CandidateRow) => {
    if (!window.confirm(`Let ${c.name} take the call again? Their earlier answers stay saved.`)) return;
    setBusyId(c.id);
    setError(null);
    try {
      await api.allowRetake(c.id);
      setNotice(`${c.name} can take the call again. Send a new invite link if they are signed out.`);
      await onReload();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  const allLinksText = (links || []).filter(l => l.invite_link).map(l => `${l.name} <${l.email}>: ${l.invite_link}`).join('\n');

  return (
    <div className="stack">
      <div className="row-wrap">
        <p className="muted small grow">
          No emails are sent. Copy each candidate's one-time link and share it with them; they open it to upload a resume and take the call.
        </p>
        <button className="btn" onClick={linksForAll} disabled={!candidates.length || busyId !== null}>
          <Link2 size={15} /> {busyId === 'all' ? 'Creating links…' : 'Links for everyone'}
        </button>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><UserPlus size={15} /> Add candidates</button>
      </div>
      <ErrorNote message={error} />
      {notice && (
        <div role="status" className="alert alert-success" style={{ wordBreak: 'break-all', marginBottom: 0 }}>
          <CheckCircle2 size={15} /><span>{notice}</span>
        </div>
      )}

      <div className="card">
        {candidates.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="No candidates yet">
            Add candidates from a CSV with Name and Email columns, or paste them in.
          </EmptyState>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Status</th><th className="actions"><span className="sr-only">Actions</span></th></tr>
              </thead>
              <tbody>
                {candidates.map(c => (
                  <tr key={c.id}>
                    <td className="strong">{c.name}</td>
                    <td className="muted">{c.email}</td>
                    <td><StatusBadge status={c.status} /></td>
                    <td className="actions">
                      <div className="btn-group">
                        {!['completed', 'failed'].includes(c.status) && (
                          <button className="btn btn-sm" onClick={() => copyLinkFor(c)} disabled={busyId !== null} title="Create and copy a one-time invite link">
                            <Copy size={14} /> {busyId === c.id ? 'Copying…' : 'Copy invite link'}
                          </button>
                        )}
                        {c.status === 'failed' && (
                          <button className="btn btn-sm" onClick={() => retake(c)} disabled={busyId !== null} title="Let this candidate take the call again">
                            <RotateCcw size={14} /> Allow retake
                          </button>
                        )}
                        {c.status === 'invited' && (
                          <button className="btn btn-ghost btn-icon btn-danger" onClick={() => remove(c)} disabled={busyId !== null} aria-label={`Remove ${c.name}`} title="Remove">
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

      {adding && (
        <AddCandidatesModal
          batchId={batchId}
          existingCount={candidates.length}
          existingEmails={candidates.map(c => c.email)}
          onClose={() => setAdding(false)}
          onAdded={async ({ added, skipped_existing }) => {
            setAdding(false);
            setNotice(`Added ${added} candidate${added === 1 ? '' : 's'}${skipped_existing ? `; ${skipped_existing} already in the batch were skipped` : ''}.`);
            await onReload();
          }}
        />
      )}

      {links && (
        <Modal title="Invite links" onClose={() => setLinks(null)} maxWidth={720}>
          <p className="small muted mb">
            Each link signs that candidate in once. Share each link only with its candidate, and make a new one if it has been used or has expired.
          </p>
          <button className="btn mb" onClick={async () => setNotice((await copy(allLinksText)) ? 'All invite links copied.' : 'Copy failed. Select the links below instead.')} disabled={!allLinksText}>
            <Copy size={14} /> Copy all
          </button>
          <ul className="list">
            {links.map(l => (
              <li key={l.candidate_id} className="list-item" style={{ padding: '12px 0', flexDirection: 'column', gap: 6 }}>
                <div><strong>{l.name}</strong> <span className="muted small">{l.email}</span></div>
                {l.invite_link ? (
                  <div className="row" style={{ width: '100%' }}>
                    <input className="input mono" readOnly value={l.invite_link} onFocus={e => e.target.select()} style={{ fontSize: 11.5 }} aria-label={`Invite link for ${l.name}`} />
                    <button className="btn btn-icon" style={{ height: 38, width: 38 }} onClick={() => copy(l.invite_link!)} aria-label={`Copy link for ${l.name}`}><Copy size={14} /></button>
                  </div>
                ) : (
                  <div className="small" style={{ color: 'var(--red)' }}>{l.error}</div>
                )}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
};
