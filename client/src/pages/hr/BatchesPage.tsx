import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Building2, CalendarDays, FolderPlus, Plus } from 'lucide-react';
import { api } from '../../services/api';
import { Batch } from '../../types';
import { BatchFormModal } from '../../components/hr/BatchFormModal';
import { EmptyState, ErrorNote } from '../../components/ui/Modal';

export const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Progress bar split by status: completed, in progress, did not finish. */
const BatchProgress: React.FC<{ batch: Batch }> = ({ batch }) => {
  const c = batch.counts;
  const total = c?.total || 0;
  const part = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  const active = (c?.resume_uploaded ?? 0) + (c?.in_call ?? 0);
  return (
    <div>
      <div className="progress" style={{ display: 'flex' }} aria-hidden="true">
        <div style={{ width: part(c?.completed ?? 0), background: 'var(--green)' }} />
        <div style={{ width: part(active), background: 'var(--blue)' }} />
        <div style={{ width: part(c?.failed ?? 0), background: 'var(--red)' }} />
      </div>
      <div className="row-wrap tiny muted mt-sm" style={{ gap: 12 }}>
        <span><strong style={{ color: 'var(--text)' }}>{c?.completed ?? 0}</strong> completed</span>
        <span><strong style={{ color: 'var(--text)' }}>{active}</strong> in progress</span>
        <span><strong style={{ color: 'var(--text)' }}>{c?.invited ?? 0}</strong> invited</span>
        {(c?.failed ?? 0) > 0 && <span><strong style={{ color: 'var(--red)' }}>{c?.failed}</strong> did not finish</span>}
      </div>
    </div>
  );
};

/** HR home: totals and every batch with its candidate progress. */
export const BatchesPage: React.FC = () => {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.listBatches().then(setBatches).catch(err => setError(err.message));
  }, []);

  const sum = (key: 'total' | 'completed' | 'failed') => (batches || []).reduce((n, b) => n + (b.counts?.[key] ?? 0), 0);

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Screening batches</h1>
          <p className="muted">Each batch is one job role with its own questions and candidates.</p>
        </div>
        <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New batch</button>
      </div>
      <ErrorNote message={error} />

      {batches && batches.length > 0 && (
        <div className="stat-row">
          <div className="stat"><div className="stat-value">{batches.length}</div><div className="stat-label">Batches</div></div>
          <div className="stat"><div className="stat-value">{sum('total')}</div><div className="stat-label">Candidates</div></div>
          <div className="stat"><div className="stat-value" style={{ color: 'var(--green)' }}>{sum('completed')}</div><div className="stat-label">Calls completed</div></div>
          <div className="stat"><div className="stat-value">{sum('failed')}</div><div className="stat-label">Did not finish</div></div>
        </div>
      )}

      {batches === null && !error && <p className="muted">Loading…</p>}
      {batches?.length === 0 && (
        <div className="card">
          <EmptyState icon={<FolderPlus size={20} />} title="No batches yet">
            Create a batch for a job role, add your HR questions, then add candidates and send their invite links.
            <div className="mt"><button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> Create the first batch</button></div>
          </EmptyState>
        </div>
      )}

      {batches && batches.length > 0 && (
        <div className="grid-cards">
          {batches.map(b => (
            <Link key={b.id} to={`/hr/batches/${b.id}`} className="card card-pad">
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <h3 style={{ marginBottom: 4 }}>{b.name}</h3>
                  <div className="strong small" style={{ color: 'var(--text-2)' }}>{b.job_role}</div>
                </div>
                <span className="tag">{b.counts?.total ?? 0} candidates</span>
              </div>
              <div className="row-wrap tiny muted mt-sm mb" style={{ gap: 12 }}>
                <span className="row" style={{ gap: 4 }}><CalendarDays size={13} /> {formatDate(b.batch_date)}</span>
                {b.company_name && <span className="row" style={{ gap: 4 }}><Building2 size={13} /> {b.company_name}</span>}
              </div>
              <BatchProgress batch={b} />
            </Link>
          ))}
        </div>
      )}

      {creating && (
        <BatchFormModal onClose={() => setCreating(false)} onSaved={(batch) => navigate(`/hr/batches/${batch.id}`)} />
      )}
    </div>
  );
};
