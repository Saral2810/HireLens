import React, { useState } from 'react';
import { api } from '../../services/api';
import { Batch } from '../../types';
import { ErrorNote, Field, Modal } from '../ui/Modal';

interface Props {
  /** Existing batch to edit; omit to create a new one. */
  batch?: Batch;
  onClose: () => void;
  onSaved: (batch: Batch) => void;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Create or edit a batch: name, date, job role, company and an optional job description. */
export const BatchFormModal: React.FC<Props> = ({ batch, onClose, onSaved }) => {
  const [name, setName] = useState(batch?.name ?? '');
  const [batchDate, setBatchDate] = useState(batch?.batch_date ?? today());
  const [jobRole, setJobRole] = useState(batch?.job_role ?? '');
  const [companyName, setCompanyName] = useState(batch?.company_name ?? '');
  const [jobDescription, setJobDescription] = useState(batch?.job_description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fields = { name, batch_date: batchDate, job_role: jobRole, company_name: companyName, job_description: jobDescription };
    try {
      onSaved(batch ? await api.updateBatch(batch.id, fields) : await api.createBatch(fields));
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={batch ? 'Edit batch' : 'New batch'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorNote message={error} />
        <Field label="Batch name">
          <input className="lx-input" required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Batch 1 – 24 Oct" />
        </Field>
        <Field label="Date">
          <input className="lx-input" type="date" required value={batchDate} onChange={e => setBatchDate(e.target.value)} />
        </Field>
        <Field label="Job role" hint="The agent mentions this, and resume questions are written for it.">
          <input className="lx-input" required maxLength={120} value={jobRole} onChange={e => setJobRole(e.target.value)} placeholder="Backend Engineer" />
        </Field>
        <Field label="Company name (optional)">
          <input className="lx-input" maxLength={120} value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Made-up company for the demo" />
        </Field>
        <Field label="Job description (optional)" hint="Helps the brain judge fit at the end of the call.">
          <textarea className="lx-input" rows={4} maxLength={4000} value={jobDescription} onChange={e => setJobDescription(e.target.value)} style={{ resize: 'vertical' }} />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="lx-restored-btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="lx-restored-btn primary" disabled={saving}>{saving ? 'Saving…' : batch ? 'Save' : 'Create batch'}</button>
        </div>
      </form>
    </Modal>
  );
};
