import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Building2, CalendarDays, Pencil, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { BatchDetail } from '../../types';
import { BatchFormModal } from '../../components/hr/BatchFormModal';
import { QuestionEditor } from '../../components/hr/QuestionEditor';
import { CandidatesPanel } from '../../components/hr/CandidatesPanel';
import { ResultsTable } from '../../components/hr/ResultsTable';
import { ErrorNote } from '../../components/ui/Modal';
import { formatDate } from './BatchesPage';

type Tab = 'questions' | 'candidates' | 'results';

/** One batch: details, HR questions, candidates and results. */
export const BatchDetailPage: React.FC = () => {
  const { batchId = '' } = useParams();
  const navigate = useNavigate();
  const [batch, setBatch] = useState<BatchDetail | null>(null);
  const [tab, setTab] = useState<Tab>('questions');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstLoad = useRef(true);

  const load = useCallback(async () => {
    try {
      const loaded = await api.getBatch(batchId);
      // Open on Results once calls have happened (first load only).
      if (firstLoad.current && loaded.candidates.some(c => c.status === 'completed' || c.status === 'failed')) setTab('results');
      firstLoad.current = false;
      setBatch(loaded);
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

  const back = <Link to="/hr" className="back-link"><ArrowLeft size={14} /> All batches</Link>;
  if (!batch) {
    return <div>{back}<ErrorNote message={error} />{!error && <p className="muted">Loading…</p>}</div>;
  }

  const completed = batch.candidates.filter(c => c.status === 'completed').length;
  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'questions', label: 'HR questions', count: batch.questions.length },
    { id: 'candidates', label: 'Candidates', count: batch.candidates.length },
    { id: 'results', label: 'Results', count: completed }
  ];

  return (
    <div>
      {back}
      <div className="page-head">
        <div>
          <h1>{batch.name}</h1>
          <div className="row-wrap small muted mt-sm" style={{ gap: 14 }}>
            <span className="strong" style={{ color: 'var(--text-2)' }}>{batch.job_role}</span>
            {batch.company_name && <span className="row" style={{ gap: 4 }}><Building2 size={14} /> {batch.company_name}</span>}
            <span className="row" style={{ gap: 4 }}><CalendarDays size={14} /> {formatDate(batch.batch_date)}</span>
          </div>
        </div>
        <div className="btn-group">
          <button className="btn" onClick={() => setEditing(true)}><Pencil size={14} /> Edit</button>
          <button className="btn btn-danger" onClick={deleteBatch}><Trash2 size={14} /> Delete</button>
        </div>
      </div>
      <ErrorNote message={error} />

      <div className="tabs" role="tablist">
        {tabs.map(t => (
          <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label} <span className="tab-count">{t.count}</span>
          </button>
        ))}
      </div>

      {tab === 'questions' && (
        <QuestionEditor batchId={batch.id} questions={batch.questions} onChange={(questions) => setBatch({ ...batch, questions })} />
      )}
      {tab === 'candidates' && <CandidatesPanel batchId={batch.id} candidates={batch.candidates} onReload={load} />}
      {tab === 'results' && <ResultsTable batchId={batch.id} onCandidatesChanged={load} />}

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
