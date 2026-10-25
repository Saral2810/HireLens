import React, { useState } from 'react';
import { CheckCircle2, FileText, UploadCloud } from 'lucide-react';
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
  const [dragging, setDragging] = useState(false);
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
    <div className="stack">
      <p className="muted">
        A text-based PDF, up to 5 MB. The assistant will ask a few questions about your own projects and experience.
      </p>
      {hasResume && !result && !file && (
        <div className="alert alert-success" style={{ marginBottom: 0 }}><CheckCircle2 size={15} /><span>Resume received. You can replace it until the call starts.</span></div>
      )}
      {result && (
        <div role="status" className={`alert ${result.readable ? 'alert-success' : 'alert-warn'}`} style={{ marginBottom: 0 }}>
          <CheckCircle2 size={15} /><span>{result.message}</span>
        </div>
      )}
      <ErrorNote message={error} />

      {file ? (
        <div className="row-wrap card card-pad" style={{ padding: 14 }}>
          <FileText size={20} className="muted" />
          <div className="grow">
            <div className="strong" style={{ wordBreak: 'break-all' }}>{file.name}</div>
            <div className="tiny muted">{Math.ceil(file.size / 1024)} KB</div>
          </div>
          <button className="btn btn-ghost" onClick={() => setFile(null)} disabled={uploading}>Change</button>
          <button className="btn btn-primary" onClick={upload} disabled={uploading}>
            {uploading ? 'Reading your resume…' : 'Upload resume'}
          </button>
        </div>
      ) : (
        <label
          className={`file-drop${dragging ? ' drag' : ''}`}
          onDragOver={e => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={e => { e.preventDefault(); setDragging(false); choose(e.dataTransfer.files?.[0]); }}
        >
          <UploadCloud size={26} />
          <span className="strong">{hasResume ? 'Choose a new PDF' : 'Choose your resume (PDF)'}</span>
          <span className="tiny muted">or drop it here</span>
          <input type="file" accept="application/pdf,.pdf" onChange={e => choose(e.target.files?.[0])} className="sr-only" />
        </label>
      )}
    </div>
  );
};
