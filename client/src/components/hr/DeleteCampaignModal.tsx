import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { Batch } from '../../types';
import { ErrorNote, Field, Modal } from '../ui/Modal';

/** Message for the campaigns list after a delete. */
export function deletedNotice(name: string, result: { candidates: number; files_removed: number }): string {
  const files = result.files_removed ? `, ${result.files_removed} resume/recording file${result.files_removed === 1 ? '' : 's'}` : '';
  return `Deleted "${name}" (${result.candidates} candidate${result.candidates === 1 ? '' : 's'}${files}).`;
}

interface Props {
  /** The campaign, with candidate counts (list rows have them; the campaign page passes its own). */
  batch: Batch;
  onClose: () => void;
  onDeleted: (result: { candidates: number; files_removed: number }) => void;
}

/**
 * Deletes a campaign. Before anyone has started it is a simple confirm. Once candidates have resumes,
 * calls or results, HR types the campaign name; a live campaign is closed first so nobody is mid-call.
 */
export const DeleteCampaignModal: React.FC<Props> = ({ batch, onClose, onDeleted }) => {
  const counts = batch.counts;
  const total = counts?.total ?? 0;
  const started = total - (counts?.invited ?? 0);
  const live = batch.status === 'live';
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameOk = typed.trim() === batch.name;

  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      if (started && live) await api.closeCampaign(batch.id);
      onDeleted(await api.deleteBatch(batch.id, started ? typed.trim() : undefined));
    } catch (err: any) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <Modal title="Delete campaign" onClose={onClose}>
      <ErrorNote message={error} />
      {started === 0 ? (
        <p className="small" style={{ lineHeight: 1.6 }}>
          Delete <strong>{batch.name}</strong> with its questions and {total} candidate{total === 1 ? '' : 's'}? Nobody has started yet, so no results are lost.
          {live && ' Invite links already emailed will stop working.'}
        </p>
      ) : (
        <>
          <p className="small" style={{ lineHeight: 1.6 }}>
            <strong>{started}</strong> of {total} candidate{total === 1 ? ' has' : 's have'} already started. Deleting <strong>{batch.name}</strong> removes for good:
          </p>
          <ul className="small" style={{ lineHeight: 1.7, margin: '8px 0 12px', paddingLeft: 20 }}>
            <li>every candidate, call, transcript, answer, summary and fit score</li>
            <li>the uploaded resumes and call recordings</li>
            <li>the questions and the campaign itself</li>
          </ul>
          {live && <p className="small muted mb-sm">The campaign is live, so it is closed first: nobody can start a new call.</p>}
          <p className="small muted mb-sm">Export the results first if you may need them.</p>
          <Field label={`Type the campaign name to confirm: ${batch.name}`}>
            <input className="input" value={typed} onChange={e => setTyped(e.target.value)} autoFocus aria-label="Campaign name" />
          </Field>
        </>
      )}
      <div className="modal-foot">
        <button type="button" className="btn" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="button" className="btn btn-danger" onClick={remove} disabled={busy || (started > 0 && !nameOk)}>
          <Trash2 size={14} /> {busy ? 'Deleting…' : started && live ? 'Close and delete' : 'Delete campaign'}
        </button>
      </div>
    </Modal>
  );
};
