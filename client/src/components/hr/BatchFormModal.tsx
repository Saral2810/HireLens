import React, { useState } from 'react';
import { api } from '../../services/api';
import { Batch, CallLanguage } from '../../types';
import { ErrorNote, Field, Modal } from '../ui/Modal';
import { ALL_CALL_LANGUAGES, CallLanguagesField } from './CallLanguagesField';

interface Props {
  /** Existing batch to edit; omit to create a new one. */
  batch?: Batch;
  onClose: () => void;
  onSaved: (batch: Batch) => void;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Create or edit a batch: name, date, job role, company, company intro, call languages and an optional job description. */
export const BatchFormModal: React.FC<Props> = ({ batch, onClose, onSaved }) => {
  const [name, setName] = useState(batch?.name ?? '');
  const [batchDate, setBatchDate] = useState(batch?.batch_date ?? today());
  const [jobRole, setJobRole] = useState(batch?.job_role ?? '');
  const [companyName, setCompanyName] = useState(batch?.company_name ?? '');
  const [companyIntro, setCompanyIntro] = useState(batch?.company_intro ?? '');
  const [languages, setLanguages] = useState<CallLanguage[]>(batch?.call_languages?.length ? batch.call_languages : ALL_CALL_LANGUAGES);
  const [jobDescription, setJobDescription] = useState(batch?.job_description ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const fields = {
      name, batch_date: batchDate, job_role: jobRole, company_name: companyName, company_intro: companyIntro,
      job_description: jobDescription, call_languages: languages
    };
    try {
      onSaved(batch ? await api.updateBatch(batch.id, fields) : await api.createBatch(fields));
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title={batch ? 'Edit campaign' : 'New campaign'} onClose={onClose}>
      <form onSubmit={submit}>
        <ErrorNote message={error} />
        <Field label="Campaign name">
          <input className="input" required maxLength={120} value={name} onChange={e => setName(e.target.value)} placeholder="Backend Engineers – November" />
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '0 14px' }}>
          <Field label="Job role" hint="The agent mentions this, and resume questions are written for it.">
            <input className="input" required maxLength={120} value={jobRole} onChange={e => setJobRole(e.target.value)} placeholder="Backend Engineer" />
          </Field>
          <Field label="Date">
            <input className="input" type="date" required value={batchDate} onChange={e => setBatchDate(e.target.value)} />
          </Field>
        </div>
        <Field label="Company name (optional)">
          <input className="input" maxLength={120} value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Made-up company for the demo" />
        </Field>
        <Field label="About the company" hint="2–4 sentences candidates should hear: what you do, who you work with, the team. The assistant turns it into a short spoken briefing.">
          <textarea className="textarea" rows={3} maxLength={1500} value={companyIntro} onChange={e => setCompanyIntro(e.target.value)} />
        </Field>
        <CallLanguagesField value={languages} onChange={setLanguages} />
        <Field label="Job description (optional)" hint="Helps the brain judge fit at the end of the call.">
          <textarea className="textarea" rows={4} maxLength={4000} value={jobDescription} onChange={e => setJobDescription(e.target.value)} />
        </Field>
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : batch ? 'Save' : 'Create campaign'}</button>
        </div>
      </form>
    </Modal>
  );
};
