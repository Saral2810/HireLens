import React, { useState } from 'react';
import { FileUp, CheckCircle2 } from 'lucide-react';
import { api } from '../../services/api';
import { ResumeUploadResult } from '../../types';
import { ErrorNote } from '../ui/Modal';

const MAX_BYTES = 5 * 1024 * 1024;

interface Props {
  hasResume: boolean;
  onUploaded: () => void;
}

/** Step 1: upload a PDF resume. The agent asks 3–5 questions about it during the call. */
export const ResumeUpload: React.FC<Props> = ({ hasResume, onUploaded }) => {
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<ResumeUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const choose = (f: File | undefined) => {
    setResult(null);
    setError(null);
    if (!f) return;
    if (f.type && f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setError('Please choose a PDF file.');
      return;
    }
    if (f.size > MAX_BYTES) {
      setError('The resume is larger than 5 MB.');
      return;
    }
    setFile(f);
  };

  const upload = async () => {
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      setResult(await api.uploadResume(file));
      setFile(null);
      onUploaded();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div>
      <p style={{ color: 'var(--lx-muted)', fontSize: 14, marginTop: 0 }}>
        Upload your resume as a text-based PDF (max 5 MB). The assistant will ask a few questions about your own projects and experience.
      </p>
      {hasResume && !result && (
        <p style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, color: 'var(--lx-green, #22c55e)' }}>
          <CheckCircle2 size={14} /> Resume received. You can replace it until the call starts.
        </p>
      )}
      <ErrorNote message={error} />
      {result && (
        <p role="status" style={{ fontSize: 13, color: result.readable ? 'var(--lx-green, #22c55e)' : '#f59e0b' }}>{result.message}</p>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="lx-restored-btn" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <FileUp size={14} /> {hasResume ? 'Choose a new PDF' : 'Choose PDF'}
          <input type="file" accept="application/pdf,.pdf" onChange={e => choose(e.target.files?.[0])} style={{ display: 'none' }} />
        </label>
        {file && <span style={{ fontSize: 13, color: 'var(--lx-muted)' }}>{file.name} ({Math.ceil(file.size / 1024)} KB)</span>}
        {file && (
          <button className="lx-restored-btn primary" onClick={upload} disabled={uploading}>
            {uploading ? 'Reading your resume…' : 'Upload'}
          </button>
        )}
      </div>
    </div>
  );
};
