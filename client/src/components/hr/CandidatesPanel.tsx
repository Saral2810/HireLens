import React, { useState } from 'react';
import { Copy, Link2, Trash2, UserPlus } from 'lucide-react';
import { api } from '../../services/api';
import { CandidateRow, InviteLinkResult } from '../../types';
import { ErrorNote, Modal } from '../ui/Modal';
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
        ? `Invite link for ${c.name} copied. It works once.`
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

  const allLinksText = (links || []).filter(l => l.invite_link).map(l => `${l.name} <${l.email}>: ${l.invite_link}`).join('\n');

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="lx-restored-btn primary" onClick={() => setAdding(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <UserPlus size={14} /> Add candidates
        </button>
        <button className="lx-restored-btn" onClick={linksForAll} disabled={!candidates.length || busyId !== null} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Link2 size={14} /> {busyId === 'all' ? 'Creating links…' : 'Invite links for everyone'}
        </button>
      </div>
      <ErrorNote message={error} />
      {notice && <p role="status" style={{ fontSize: 13, color: 'var(--lx-green, #22c55e)', wordBreak: 'break-all' }}>{notice}</p>}

      {candidates.length === 0 ? (
        <div style={{ padding: 16, border: '1px dashed var(--lx-border)', borderRadius: 8, color: 'var(--lx-muted)', fontSize: 14 }}>
          No candidates yet. Add them from a CSV with Name and Email columns.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--lx-muted)' }}>
                {['Name', 'Email', 'Status', ''].map((h, i) => <th key={i} style={{ padding: '6px 8px', borderBottom: '1px solid var(--lx-border)' }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {candidates.map(c => (
                <tr key={c.id}>
                  <td style={{ padding: '7px 8px' }}>{c.name}</td>
                  <td style={{ padding: '7px 8px', color: 'var(--lx-muted)' }}>{c.email}</td>
                  <td style={{ padding: '7px 8px' }}><StatusBadge status={c.status} /></td>
                  <td style={{ padding: '7px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {!['completed', 'failed'].includes(c.status) && (
                      <button className="lx-restored-btn" onClick={() => copyLinkFor(c)} disabled={busyId !== null} title="Create and copy a one-time invite link" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, marginRight: 4 }}>
                        <Copy size={13} /> {busyId === c.id ? '…' : 'Invite link'}
                      </button>
                    )}
                    {c.status === 'invited' && (
                      <button className="lx-restored-btn" onClick={() => remove(c)} disabled={busyId !== null} aria-label={`Remove ${c.name}`} title="Remove">
                        <Trash2 size={13} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
          <p style={{ fontSize: 13, color: 'var(--lx-muted)', marginTop: 0 }}>
            Each link signs that candidate in once. Share each link only with its candidate. Generate a new one if it has been used or has expired.
          </p>
          <button className="lx-restored-btn" onClick={async () => setNotice((await copy(allLinksText)) ? 'All invite links copied.' : 'Copy failed. Select the links below instead.')}
            disabled={!allLinksText} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10 }}>
            <Copy size={13} /> Copy all
          </button>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {links.map(l => (
              <li key={l.candidate_id} style={{ padding: '8px 0', borderBottom: '1px solid var(--lx-border)', fontSize: 13 }}>
                <div><strong>{l.name}</strong> <span style={{ color: 'var(--lx-muted)' }}>{l.email}</span></div>
                {l.invite_link ? (
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                    <input className="lx-input" readOnly value={l.invite_link} onFocus={e => e.target.select()} style={{ fontSize: 11, fontFamily: 'monospace' }} aria-label={`Invite link for ${l.name}`} />
                    <button className="lx-restored-btn" onClick={() => copy(l.invite_link!)} aria-label={`Copy link for ${l.name}`}><Copy size={13} /></button>
                  </div>
                ) : (
                  <div style={{ color: '#fca5a5', marginTop: 4 }}>{l.error}</div>
                )}
              </li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
};
