import React, { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { BatchDetail } from '../../types';
import { BatchFormModal } from '../../components/hr/BatchFormModal';
import { QuestionEditor } from '../../components/hr/QuestionEditor';
import { CandidatesPanel } from '../../components/hr/CandidatesPanel';
import { ErrorNote } from '../../components/ui/Modal';

type Tab = 'questions' | 'candidates' | 'results';

/** One batch: details, HR questions, candidates (and results from Phase H). */
export const BatchDetailPage: React.FC = () => {
  const { batchId = '' } = useParams();
  const navigate = useNavigate();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [tab, setTab] = useState<Tab>('questions');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBatch(await api.getBatch(batchId));
    } catch (err: any) {
      setError(err.message);
    }
  }, [batchId]);

  useEffect(() => { load(); }, [load]);

  const deleteBatch = async () => {
    if (!batch || !window.confirm(`Delete "${batch.name}" with its questions and candidates? This cannot be undone.`)) return;
    try {
      await api.deleteBatch(batch.id);
      navigate('/hr', { replace: true });
    } catch (err: any) {
      setError(err.message);
    }
  };

  if (!batch) {
    return (
      <div>
        <Link to="/hr" style={{ color: 'var(--lx-muted)', fontSize: 13 }}>← All batches</Link>
        <ErrorNote message={error} />
        {!error && <p style={{ color: 'var(--lx-muted)' }}>Loading…</p>}
      </div>
    );
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: 'questions', label: `HR questions (${batch.questions.length})` },
    { id: 'candidates', label: `Candidates (${batch.candidates.length})` },
    { id: 'results', label: 'Results' }
  ];

  return (
    <div style={{ maxWidth: 1000 }}>
      <Link to="/hr" style={{ color: 'var(--lx-muted)', fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <ArrowLeft size={13} /> All batches
      </Link>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap', margin: '10px 0 16px' }}>
        <div>
          <h2 style={{ margin: 0 }}>{batch.name}</h2>
          <div style={{ color: 'var(--lx-muted)', fontSize: 14, marginTop: 4 }}>
            {batch.job_role}{batch.company_name ? ` · ${batch.company_name}` : ''} · {new Date(`${batch.batch_date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="lx-restored-btn" onClick={() => setEditing(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Pencil size={13} /> Edit</button>
          <button className="lx-restored-btn" onClick={deleteBatch} style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Trash2 size={13} /> Delete</button>
        </div>
      </div>
      <ErrorNote message={error} />

      <div role="tablist" style={{ display: 'flex', gap: 4, borderBottom: '1px solid var(--lx-border)', marginBottom: 16, flexWrap: 'wrap' }}>
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => setTab(t.id)}
            style={{
              background: 'none', border: 'none', cursor: 'pointer', padding: '8px 12px', fontSize: 14,
              color: tab === t.id ? 'var(--lx-text)' : 'var(--lx-muted)',
              borderBottom: tab === t.id ? '2px solid var(--lx-accent, #818cf8)' : '2px solid transparent', fontWeight: tab === t.id ? 600 : 400
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'questions' && (
        <QuestionEditor batchId={batch.id} questions={batch.questions} onChange={(questions) => setBatch({ ...batch, questions })} />
      )}
      {tab === 'candidates' && <CandidatesPanel batchId={batch.id} candidates={batch.candidates} onReload={load} />}
      {tab === 'results' && (
        <p style={{ color: 'var(--lx-muted)' }}>Each candidate's answers, transcript and recording appear here once their calls are done.</p>
      )}

      {editing && (
        <BatchFormModal
          batch={batch}
          onClose={() => setEditing(false)}
          onSaved={(updated) => { setBatch({ ...batch, ...updated }); setEditing(false); }}
        />
      )}
    </div>
  );
};
