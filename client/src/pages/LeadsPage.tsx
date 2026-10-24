import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/api';
import { Lead } from '../types';
import { 
  Search, 
  Filter, 
  Download, 
  Eye, 
  Sparkles, 
  Phone, 
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ShieldAlert
} from 'lucide-react';

export const LeadsPage: React.FC = () => {
  const { activeTenant, setSelectedLeadId } = useAppStore();
  const [leads, setLeads] = useState<Lead[]>([]);
  const [totalLeads, setTotalLeads] = useState(0);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const pageSize = 15;

  const loadLeads = async () => {
    setLoading(true);
    try {
      const res = await api.getLeads({
        limit: pageSize,
        offset: (page - 1) * pageSize,
        status: statusFilter,
        search: search.trim()
      });
      setLeads(res.leads || []);
      setTotalLeads(res.total || (res.leads || []).length);
    } catch {
      setLeads([]);
      setTotalLeads(0);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLeads();
  }, [activeTenant, statusFilter, page]);

  return (
    <div className="lx-page show">
      {/* Header */}
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Lead Intelligence Feed
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Comprehensive Contact Database, AI Scoring Audits & Speech Transcripts ({activeTenant.toUpperCase()})
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button 
            type="button" 
            className="lx-btn" 
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => window.open(`/leads/export?tenant_id=${encodeURIComponent(api.getTenant())}`, '_blank')}
          >
            <Download size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div style={{ 
        display: 'flex', 
        alignItems: 'center', 
        justifyContent: 'space-between', 
        background: 'var(--lx-card)', 
        border: '1px solid var(--lx-border)', 
        borderRadius: 12, 
        padding: '12px 16px', 
        marginBottom: 16,
        gap: 12,
        flexWrap: 'wrap'
      }}>
        {/* Search */}
        <div style={{ position: 'relative', width: 280 }}>
          <Search size={14} style={{ position: 'absolute', left: 12, top: 13, color: 'var(--lx-muted)' }} />
          <input 
            type="text" 
            className="lx-input" 
            placeholder="Search phone, name or ID..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') loadLeads(); }}
            style={{ paddingLeft: 34, height: 38 }}
          />
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <select 
            className="lx-select" 
            style={{ width: 160 }}
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="QUALIFIED">Qualified</option>
            <option value="ESCALATED">Escalated</option>
            <option value="CALL_NEEDED">Call Needed</option>
            <option value="NO_ANSWER">No Answer</option>
            <option value="BUSY">Busy</option>
            <option value="DNC">DNC Blocked</option>
          </select>

          <button 
            type="button" 
            className="lx-btn lx-btn-small" 
            onClick={loadLeads}
            disabled={loading}
          >
            <RefreshCw size={13} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>
      </div>

      {/* Leads Table */}
      <div style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, overflow: 'hidden' }}>
        <table className="lx-table" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: 13 }}>
          <thead>
            <tr style={{ background: 'rgba(255,255,255,0.02)', borderBottom: '1px solid var(--lx-border)' }}>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--lx-muted)' }}>Lead Contact</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--lx-muted)' }}>Status</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--lx-muted)' }}>Propensity Score</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--lx-muted)' }}>Attempts</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--lx-muted)' }}>Last Dialed</th>
              <th style={{ padding: '12px 18px', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--lx-muted)', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 36, color: 'var(--lx-muted)' }}>
                  Loading leads database...
                </td>
              </tr>
            ) : leads.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ textAlign: 'center', padding: 36, color: 'var(--lx-muted)' }}>
                  No leads found matching query.
                </td>
              </tr>
            ) : (
              leads.map((l) => (
                <tr 
                  key={l.id} 
                  style={{ borderBottom: '1px solid var(--lx-border)', transition: 'background 0.15s ease' }}
                  className="lx-table-row"
                >
                  <td style={{ padding: '12px 18px' }}>
                    <div style={{ fontWeight: 600, color: 'var(--lx-text)' }}>{l.name}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--lx-muted)', fontFamily: 'var(--lx-mono)', marginTop: 2 }}>
                      {l.phone}
                    </div>
                  </td>

                  <td style={{ padding: '12px 18px' }}>
                    <span className={`lx-badge ${
                      l.status === 'QUALIFIED' ? 'badge-green' : 
                      (l.status === 'ESCALATED' ? 'badge-amber' : 
                      (l.status === 'DNC' ? 'badge-red' : 'badge-gray'))
                    }`}>
                      {l.status}
                    </span>
                  </td>

                  <td style={{ padding: '12px 18px' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ 
                        fontWeight: 700, 
                        fontSize: 12, 
                        color: l.lead_score >= 80 ? 'var(--lx-green)' : (l.lead_score >= 50 ? 'var(--lx-accent)' : 'var(--lx-muted)') 
                      }}>
                        {l.lead_score}
                      </span>
                      <div style={{ width: 60, height: 5, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                        <div style={{ 
                          width: `${l.lead_score}%`, 
                          height: '100%', 
                          background: l.lead_score >= 80 ? 'var(--lx-green)' : 'var(--lx-accent)' 
                        }} />
                      </div>
                    </div>
                  </td>

                  <td style={{ padding: '12px 18px', color: 'var(--lx-muted)' }}>
                    {l.attempts} / 3
                  </td>

                  <td style={{ padding: '12px 18px', color: 'var(--lx-muted)', fontSize: 12 }}>
                    {l.last_call_at || '--'}
                  </td>

                  <td style={{ padding: '12px 18px', textAlign: 'right' }}>
                    <button 
                      type="button" 
                      className="lx-action-btn lx-action-btn--copy"
                      onClick={() => setSelectedLeadId(l.id)}
                      title="View AI intelligence & audio transcript"
                    >
                      <Eye size={13} /> View Audit
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>

        {/* Pagination Bar */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 18px', borderTop: '1px solid var(--lx-border)', fontSize: 12 }}>
          <span style={{ color: 'var(--lx-muted)' }}>
            Showing page {page} of {Math.ceil(totalLeads / pageSize)} ({totalLeads.toLocaleString()} total leads)
          </span>

          <div style={{ display: 'flex', gap: 6 }}>
            <button 
              type="button" 
              className="lx-btn lx-btn-small" 
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              <ChevronLeft size={13} /> Prev
            </button>
            <button 
              type="button" 
              className="lx-btn lx-btn-small" 
              disabled={page >= Math.ceil(totalLeads / pageSize)}
              onClick={() => setPage(page + 1)}
            >
              Next <ChevronRight size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
