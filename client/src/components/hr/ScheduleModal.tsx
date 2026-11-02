import React, { useState } from 'react';
import { api } from '../../services/api';
import { Batch } from '../../types';
import { ErrorNote, Field, Modal } from '../ui/Modal';
import { fromLocalInput, nextHourLocal, toLocalInput } from '../../lib/schedule';

interface Props {
  batch: Batch;
  onClose: () => void;
  onSaved: (batch: Batch) => void;
}

/**
 * Schedule a campaign: a draft starts by itself at the start time (and every candidate is emailed
 * their invite then); an optional close time closes it by itself. A running campaign only gets a close time.
 */
export const ScheduleModal: React.FC<Props> = ({ batch, onClose, onSaved }) => {
  const draft = (batch.status || 'draft') === 'draft';
  const [start, setStart] = useState(toLocalInput(batch.scheduled_at) || nextHourLocal());
  const [close, setClose] = useState(toLocalInput(batch.closes_at));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.scheduleCampaign(batch.id, { start_at: draft ? fromLocalInput(start) : undefined, close_at: fromLocalInput(close) }));
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={draft ? 'Schedule campaign' : 'Set an end time'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorNote message={error} />
        {draft && (
          <Field label="Start on" hint="At this time the campaign goes live and every candidate is emailed their invite link. Until then candidates cannot see it.">
            <input className="input" type="datetime-local" required value={start} min={toLocalInput(new Date().toISOString())} onChange={e => setStart(e.target.value)} />
          </Field>
        )}
        <Field label="End on (optional)" hint="The campaign is marked completed at this time: calls cannot start after it. Results stay available.">
          <input className="input" type="datetime-local" value={close} min={draft ? start : toLocalInput(new Date().toISOString())} onChange={e => setClose(e.target.value)} />
        </Field>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : draft ? 'Schedule' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
};
