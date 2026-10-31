import React, { useState } from 'react';
import { api } from '../../services/api';
import { CandidateRow, EmailQueueResult } from '../../types';
import { ErrorNote, Field, Modal } from '../ui/Modal';

interface Props {
  candidate: CandidateRow;
  onClose: () => void;
  onSaved: (result: { emailChanged: boolean; emails: EmailQueueResult }) => void;
}

/** Corrects a candidate's name (any time) or email (only before they start). */
export const EditCandidateModal: React.FC<Props> = ({ candidate, onClose, onSaved }) => {
  const [name, setName] = useState(candidate.name);
  const [email, setEmail] = useState(candidate.email);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canChangeEmail = candidate.status === 'invited';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const fields: { name?: string; email?: string } = { name };
      if (canChangeEmail) fields.email = email;
      const updated = await api.updateCandidate(candidate.id, fields);
      onSaved({ emailChanged: updated.email !== candidate.email, emails: updated.emails });
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Edit candidate" onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorNote message={error} />
        <Field label="Full name">
          <input className="input" required maxLength={120} value={name} onChange={e => setName(e.target.value)} />
        </Field>
        <Field label="Email" hint={canChangeEmail
          ? 'A new email gets a fresh invite (if the campaign is running); the old link stops working.'
          : 'This candidate has already started, so the email cannot change.'}>
          <input className="input" type="email" required value={email} onChange={e => setEmail(e.target.value)} disabled={!canChangeEmail} />
        </Field>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
};
