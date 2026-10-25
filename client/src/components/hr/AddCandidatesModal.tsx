import React, { useMemo, useState } from 'react';
import { Upload } from 'lucide-react';
import { api } from '../../services/api';
import { readCandidatesCsv } from '../../lib/csv';
import { ErrorNote, Field, Modal } from '../ui/Modal';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PER_BATCH = 100;

interface Props {
  batchId: string;
  existingCount: number;
  existingEmails: string[];
  onClose: () => void;
  onAdded: (summary: { added: number; skipped_existing: number }) => void;
}

/**
 * Add candidates from a CSV file or pasted text with "Name" and "Email" columns.
 * Rows are checked here first (and again on the server); nothing is saved until all rows are valid.
 */
export const AddCandidatesModal: React.FC<Props> = ({ batchId, existingCount, existingEmails, onClose, onAdded }) => {
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parsed = useMemo(() => (text.trim() ? readCandidatesCsv(text) : null), [text]);
  const existing = useMemo(() => new Set(existingEmails.map(e => e.toLowerCase())), [existingEmails]);

  const preview = useMemo(() => {
    if (!parsed || parsed.problem) return [];
    const seen = new Set<string>();
    return parsed.rows.map((r, i) => {
      const email = r.email.toLowerCase();
      let issue: string | null = null;
      if (!r.name) issue = 'Name missing';
      else if (!EMAIL_RE.test(email)) issue = 'Invalid email';
      else if (seen.has(email)) issue = 'Repeated in this list';
      else if (existing.has(email)) issue = 'Already in batch (will be skipped)';
      seen.add(email);
      return { row: i + 1, ...r, issue };
    });
  }, [parsed, existing]);

  const blocking = preview.filter(p => p.issue && !p.issue.startsWith('Already'));
  const toAdd = preview.filter(p => !p.issue);
  const overLimit = existingCount + toAdd.length > MAX_PER_BATCH;

  const loadFile = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 1024 * 1024) { setError('That file is larger than 1 MB. Export only the name and email columns.'); return; }
    file.text().then(setText).catch(() => setError('Could not read that file.'));
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      onAdded(await api.addCandidates(batchId, toAdd.map(({ name, email }) => ({ name, email }))));
    } catch (err: any) {
      setError(err.message);
      setSaving(false);
    }
  };

  return (
    <Modal title="Add candidates" onClose={onClose} maxWidth={680}>
      <p style={{ fontSize: 13, color: 'var(--lx-muted)', marginTop: 0 }}>
        Use a CSV with <strong>Name</strong> and <strong>Email</strong> columns (other columns are ignored). Up to {MAX_PER_BATCH} candidates per batch; this batch has {existingCount}.
        For the contest, use made-up candidates only.
      </p>
      <ErrorNote message={error} />

      <Field label="CSV file">
        <label className="lx-restored-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <Upload size={14} /> Choose file
          <input type="file" accept=".csv,text/csv,text/plain" onChange={e => loadFile(e.target.files?.[0])} style={{ display: 'none' }} />
        </label>
      </Field>
      <Field label="…or paste rows">
        <textarea className="lx-input" rows={5} value={text} onChange={e => setText(e.target.value)}
          placeholder={'Name,Email\nAsha Rao,asha.rao@example.com\nVikram Shah,vikram@example.com'} style={{ resize: 'vertical', fontFamily: 'monospace', fontSize: 12 }} />
      </Field>

      {parsed?.problem && <ErrorNote message={parsed.problem} />}

      {preview.length > 0 && (
        <div style={{ maxHeight: 260, overflowY: 'auto', border: '1px solid var(--lx-border)', borderRadius: 8, marginBottom: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--lx-muted)' }}>
                {['Row', 'Name', 'Email', 'Check'].map(h => <th key={h} style={{ padding: '6px 8px', borderBottom: '1px solid var(--lx-border)' }}>{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {preview.map(p => (
                <tr key={p.row}>
                  <td style={{ padding: '5px 8px', color: 'var(--lx-muted)' }}>{p.row}</td>
                  <td style={{ padding: '5px 8px' }}>{p.name || '—'}</td>
                  <td style={{ padding: '5px 8px' }}>{p.email || '—'}</td>
                  <td style={{ padding: '5px 8px', color: p.issue ? (p.issue.startsWith('Already') ? 'var(--lx-muted)' : '#fca5a5') : 'var(--lx-green, #22c55e)' }}>
                    {p.issue || 'OK'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {blocking.length > 0 && <ErrorNote message={`Fix ${blocking.length} row(s) marked in red, then add again.`} />}
      {overLimit && <ErrorNote message={`That would make ${existingCount + toAdd.length} candidates; the limit is ${MAX_PER_BATCH}.`} />}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button className="lx-restored-btn" onClick={onClose}>Cancel</button>
        <button className="lx-restored-btn primary" onClick={submit} disabled={saving || !toAdd.length || blocking.length > 0 || overLimit}>
          {saving ? 'Adding…' : `Add ${toAdd.length} candidate${toAdd.length === 1 ? '' : 's'}`}
        </button>
      </div>
    </Modal>
  );
};
