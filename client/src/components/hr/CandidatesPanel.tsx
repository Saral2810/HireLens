import React, { useState } from 'react';
import { Check, RotateCcw, Trash2, UserPlus, Users } from 'lucide-react';
import { api } from '../../services/api';
import { CandidateRow } from '../../types';
import { EmptyState, ErrorNote } from '../ui/Modal';
import { AddCandidatesModal } from './AddCandidatesModal';
import { StatusBadge } from './StatusBadge';

interface Props {
  batchId: string;
  candidates: CandidateRow[];
  onReload: () => Promise<void>;
}

/**
 * Candidates in a campaign: add (Excel, CSV or typed), remove before they start, track status,
 * and allow a retake. Candidates sign in themselves with the email added here.
 */
export const CandidatesPanel: React.FC<Props> = ({ batchId, candidates, onReload }) => {
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="stack">
      <div className="row-wrap">
        <p className="muted small grow">Candidates sign in with Google or an email code using exactly the email below. Emails are not sent by the app.</p>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><UserPlus size={15} /> Add candidates</button>
      </div>
      <ErrorNote message={error} />
      {notice && <div role="status" className="alert" style={{ marginBottom: 0 }}><Check size={15} /><span>{notice}</span></div>}

      <div className="card">
        {candidates.length === 0 ? (
          <EmptyState icon={<Users size={20} />} title="No candidates yet">
            Upload an Excel or CSV file with Name and Email columns, or add people by hand.
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
                        {c.status === 'failed' && (
                          <button className="btn btn-sm" onClick={() => retake(c)} disabled={busyId !== null} title="Let this candidate take the call again">
                            <RotateCcw size={14} /> Allow retake
                          </button>
                        )}
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

      {adding && (
        <AddCandidatesModal
          batchId={batchId}
          existingCount={candidates.length}
          existingEmails={candidates.map(c => c.email)}
          onClose={() => setAdding(false)}
          onAdded={async ({ added, skipped_existing }) => {
            setAdding(false);
            setNotice(`Added ${added} candidate${added === 1 ? '' : 's'}${skipped_existing ? `; ${skipped_existing} already in the campaign were skipped` : ''}.`);
            await onReload();
          }}
        />
      )}
    </div>
  );
};
