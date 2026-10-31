import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Building2, CalendarDays, Check, FolderPlus, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import { Batch, CampaignStatus } from '../../types';
import { EmptyState, ErrorNote } from '../../components/ui/Modal';
import { CampaignBadge } from '../../components/hr/StatusBadge';
import { BatchFormModal } from '../../components/hr/BatchFormModal';
import { DeleteCampaignModal, deletedNotice } from '../../components/hr/DeleteCampaignModal';

export const formatDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** Progress bar: completed (solid), in progress (hatched), the rest empty. */
export const CampaignProgress: React.FC<{ batch: Batch }> = ({ batch }) => {
  const c = batch.counts;
  const total = c?.total || 0;
  const part = (n: number) => `${total ? (n / total) * 100 : 0}%`;
  const active = (c?.resume_uploaded ?? 0) + (c?.in_call ?? 0);
  return (
    <div>
      <div className="progress" style={{ display: 'flex' }} aria-hidden="true">
        <div style={{ width: part(c?.completed ?? 0) }} />
        <div className="bar-fill alt" style={{ width: part(active) }} />
      </div>
      <div className="row-wrap tiny muted mt-sm" style={{ gap: 12 }}>
        <span><strong style={{ color: 'var(--text)' }}>{c?.completed ?? 0}</strong> completed</span>
        <span><strong style={{ color: 'var(--text)' }}>{active}</strong> in progress</span>
        <span><strong style={{ color: 'var(--text)' }}>{c?.invited ?? 0}</strong> not started</span>
        {(c?.failed ?? 0) > 0 && <span><strong style={{ color: 'var(--text)' }}>{c?.failed}</strong> did not finish</span>}
      </div>
    </div>
  );
};

type Filter = 'all' | CampaignStatus;

/** Every campaign the user can see (Admin: all; Recruiter: their own). */
export const CampaignsPage: React.FC = () => {
  const [campaigns, setCampaigns] = useState<Batch[] | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [error, setError] = useState<string | null>(null);
  const location = useLocation();
  const [notice, setNotice] = useState<string | null>((location.state as { notice?: string } | null)?.notice || null);
  const [editing, setEditing] = useState<Batch | null>(null);
  const [deleting, setDeleting] = useState<Batch | null>(null);

  useEffect(() => { api.listBatches().then(setCampaigns).catch(err => setError(err.message)); }, []);

  const count = (s: CampaignStatus) => campaigns?.filter(c => (c.status || 'draft') === s).length ?? 0;
  const shown = useMemo(() => (campaigns || []).filter(c => filter === 'all' || (c.status || 'draft') === filter), [campaigns, filter]);
  const filters: { id: Filter; label: string; n: number }[] = [
    { id: 'all', label: 'All', n: campaigns?.length ?? 0 },
    { id: 'live', label: 'Live', n: count('live') },
    { id: 'draft', label: 'Draft', n: count('draft') },
    { id: 'closed', label: 'Closed', n: count('closed') }
  ];

  return (
    <div>
      <div className="page-head">
        <div>
          <span className="eyebrow">Campaigns</span>
          <h1>Screening campaigns</h1>
          <p className="muted">Each campaign is one job role with its own questions and candidates.</p>
        </div>
        <Link to="/hr/campaigns/new" className="btn btn-primary"><Plus size={16} /> New campaign</Link>
      </div>
      <ErrorNote message={error} />
      {notice && <div className="alert" role="status"><Check size={15} /><span>{notice}</span></div>}

      {campaigns && campaigns.length > 0 && (
        <div className="tabs" role="tablist">
          {filters.map(f => (
            <button key={f.id} role="tab" className="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
              {f.label} <span className="tab-count">{f.n}</span>
            </button>
          ))}
        </div>
      )}

      {campaigns === null && !error && <p className="muted">Loading…</p>}
      {campaigns?.length === 0 && (
        <div className="card">
          <EmptyState icon={<FolderPlus size={20} />} title="No campaigns yet">
            Create a campaign, add candidates from Excel or by hand, then run it.
            <div className="mt"><Link to="/hr/campaigns/new" className="btn btn-primary"><Plus size={16} /> New campaign</Link></div>
          </EmptyState>
        </div>
      )}
      {campaigns && campaigns.length > 0 && shown.length === 0 && <p className="muted">No {filter} campaigns.</p>}

      {shown.length > 0 && (
        <div className="grid-cards">
          {shown.map(b => (
            <div key={b.id} className="card card-pad" style={{ display: 'flex', flexDirection: 'column' }}>
              <Link to={`/hr/campaigns/${b.id}`} style={{ color: 'inherit', textDecoration: 'none', flex: 1 }}>
              <div className="row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <h3 style={{ marginBottom: 4 }}>{b.name}</h3>
                  <div className="small" style={{ color: 'var(--text-2)' }}>{b.job_role}</div>
                </div>
                <CampaignBadge status={b.status || 'draft'} scheduled={!!b.scheduled_at} />
              </div>
              <div className="row-wrap tiny muted mt-sm mb" style={{ gap: 12 }}>
                <span className="row" style={{ gap: 4 }}><CalendarDays size={13} /> {formatDate(b.batch_date)}</span>
                {b.company_name && <span className="row" style={{ gap: 4 }}><Building2 size={13} /> {b.company_name}</span>}
                <span className="tag spacer">{b.counts?.total ?? 0} candidates</span>
              </div>
              <CampaignProgress batch={b} />
              </Link>
              <div className="row mt-sm" style={{ justifyContent: 'flex-end', gap: 4 }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setEditing(b)} aria-label={`Edit ${b.name}`}><Pencil size={14} /> Edit</button>
                <button className="btn btn-ghost btn-sm btn-danger" onClick={() => setDeleting(b)} aria-label={`Delete ${b.name}`}><Trash2 size={14} /> Delete</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <BatchFormModal
          batch={editing}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setCampaigns(list => (list || []).map(c => (c.id === updated.id ? { ...c, ...updated, counts: c.counts } : c)));
            setEditing(null);
            setNotice(`Saved "${updated.name}".`);
          }}
        />
      )}
      {deleting && (
        <DeleteCampaignModal
          batch={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(result) => {
            setCampaigns(list => (list || []).filter(c => c.id !== deleting.id));
            setNotice(deletedNotice(deleting.name, result));
            setDeleting(null);
          }}
        />
      )}
    </div>
  );
};
