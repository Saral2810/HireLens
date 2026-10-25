import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { api } from '../../services/api';
import { Batch } from '../../types';
import { BatchFormModal } from '../../components/hr/BatchFormModal';
import { ErrorNote } from '../../components/ui/Modal';

const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** HR home: every batch with its candidate progress. */
export const BatchesPage: React.FC = () => {
  const [batches, setBatches] = useState<Batch[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    api.listBatches().then(setBatches).catch(err => setError(err.message));
  }, []);

  return (
    <div style={{ maxWidth: 1000 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Batches</h2>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="lx-restored-btn primary" onClick={() => setCreating(true)} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <Plus size={14} /> New batch
          </button>
        </div>
      </div>
      <ErrorNote message={error} />

      {batches === null && !error && <p style={{ color: 'var(--lx-muted)' }}>Loading…</p>}
      {batches?.length === 0 && (
        <div style={{ padding: 20, border: '1px dashed var(--lx-border)', borderRadius: 8, color: 'var(--lx-muted)' }}>
          No batches yet. Create one for a job role, add HR questions, then add candidates.
        </div>
      )}

      {batches && batches.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--lx-muted)', fontSize: 12 }}>
                {['Batch', 'Date', 'Job role', 'Candidates', 'Completed', 'In progress', 'Failed'].map(h => (
                  <th key={h} style={{ padding: '8px 10px', borderBottom: '1px solid var(--lx-border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {batches.map(b => {
                const c = b.counts;
                return (
                  <tr key={b.id} onClick={() => navigate(`/hr/batches/${b.id}`)} style={{ cursor: 'pointer' }}>
                    <td style={{ padding: '10px' }}><Link to={`/hr/batches/${b.id}`} style={{ color: 'var(--lx-text)', fontWeight: 600 }}>{b.name}</Link></td>
                    <td style={{ padding: '10px', color: 'var(--lx-muted)' }}>{formatDate(b.batch_date)}</td>
                    <td style={{ padding: '10px' }}>{b.job_role}</td>
                    <td style={{ padding: '10px' }}>{c?.total ?? 0}</td>
                    <td style={{ padding: '10px' }}>{c?.completed ?? 0}</td>
                    <td style={{ padding: '10px' }}>{(c?.resume_uploaded ?? 0) + (c?.in_call ?? 0)}</td>
                    <td style={{ padding: '10px' }}>{c?.failed ?? 0}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <BatchFormModal onClose={() => setCreating(false)} onSaved={(batch) => navigate(`/hr/batches/${batch.id}`)} />
      )}
    </div>
  );
};
