import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/api';
import { DashboardStats, FunnelStage } from '../types';
import { 
  Users, 
  PhoneCall, 
  CheckCircle, 
  AlertTriangle, 
  RefreshCw, 
  TrendingUp, 
  Sparkles, 
  ArrowRight,
  Clock
} from 'lucide-react';

export const DashboardPage: React.FC = () => {
  const { activeTenant, setActivePage, setSelectedLeadId } = useAppStore();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [funnel, setFunnel] = useState<FunnelStage[]>([]);
  const [dateFilter, setDateFilter] = useState('7d');
  const [loading, setLoading] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<string>(new Date().toLocaleTimeString());

  const loadData = async () => {
    setLoading(true);
    try {
      const [s, f] = await Promise.all([
        api.getDashboardStats('all', dateFilter),
        api.getFunnelAnalytics('all', dateFilter)
      ]);
      setStats(s);
      setFunnel(f);
      setLastRefreshed(new Date().toLocaleTimeString());
    } catch (e) {
      console.warn('Dashboard fetch failed, using fallback metrics', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 20000); // Auto-refresh telemetry
    return () => clearInterval(interval);
  }, [activeTenant, dateFilter]);

  return (
    <div className="lx-page show">
      {/* Title & Filter Bar */}
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 16 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Dashboard Overview
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Real-Time AI Calling Telemetry & Lead Qualification Funnel ({activeTenant.toUpperCase()})
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <select 
            className="lx-select" 
            style={{ width: 140 }}
            value={dateFilter}
            onChange={(e) => setDateFilter(e.target.value)}
          >
            <option value="today">Today</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
          </select>

          <button 
            type="button" 
            className="lx-btn lx-btn-small" 
            onClick={loadData}
            disabled={loading}
          >
            <RefreshCw size={13} style={{ display: 'inline', marginRight: 6, animation: loading ? 'spin 1s linear infinite' : 'none' }} />
            Refresh
          </button>
        </div>
      </div>

      {/* Real-Time Status Bar */}
      <div className="lx-realtime-bar" style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 16px', background: 'rgba(255,255,255,0.02)', border: '1px solid var(--lx-border)', borderRadius: 10, marginBottom: 20 }}>
        <span className="lx-dot" style={{ width: 7, height: 7, background: 'var(--lx-green)', boxShadow: '0 0 8px var(--lx-green)' }}></span>
        <strong style={{ fontSize: 12.5 }}>Telephony Engine Active</strong>
        <div style={{ width: 1, height: 16, background: 'var(--lx-border)' }}></div>
        <span style={{ fontSize: 12, color: 'var(--lx-muted)' }}>{stats?.total_leads || 0} leads processed</span>
        <div style={{ width: 1, height: 16, background: 'var(--lx-border)' }}></div>
        <span style={{ fontSize: 12, color: 'var(--lx-muted)' }}>Voice provider: Gnani.ai</span>
        <div style={{ width: 1, height: 16, background: 'var(--lx-border)' }}></div>
        <span style={{ fontSize: 11.5, color: 'var(--lx-muted)', marginLeft: 'auto' }}>
          Last sync: {lastRefreshed}
        </span>
      </div>

      {/* KPI Cards Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 24 }}>
        {/* Total Leads */}
        <div className="lx-stat">
          <div className="lx-stat-icon-wrapper" style={{ background: 'rgba(99, 102, 241, 0.1)', color: 'var(--lx-accent)' }}>
            <Users size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="lx-stat-label">Total Leads</div>
            <div className="lx-stat-val">{(stats?.total_leads ?? 0).toLocaleString()}</div>
            <div className="lx-stat-delta" style={{ color: 'var(--lx-muted)', fontSize: 11 }}>
              100% Ingested Base
            </div>
          </div>
        </div>

        {/* Connected Calls */}
        <div className="lx-stat">
          <div className="lx-stat-icon-wrapper" style={{ background: 'rgba(59, 130, 246, 0.1)', color: '#3b82f6' }}>
            <PhoneCall size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="lx-stat-label">Connected Calls</div>
            <div className="lx-stat-val">{(stats?.connected_leads ?? 0).toLocaleString()}</div>
            <div className="lx-stat-delta" style={{ color: 'var(--lx-green)', fontSize: 11 }}>
              {stats?.contact_rate ?? 0}% Contact Rate
            </div>
          </div>
        </div>

        {/* AI Qualified */}
        <div className="lx-stat">
          <div className="lx-stat-icon-wrapper" style={{ background: 'rgba(34, 197, 94, 0.1)', color: 'var(--lx-green)' }}>
            <CheckCircle size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="lx-stat-label">AI Qualified</div>
            <div className="lx-stat-val">{(stats?.qualified_leads ?? 0).toLocaleString()}</div>
            <div className="lx-stat-delta" style={{ color: 'var(--lx-green)', fontSize: 11 }}>
              {stats?.qualification_rate ?? 0}% Qualification Yield
            </div>
          </div>
        </div>

        {/* Escalated / High Value */}
        <div className="lx-stat">
          <div className="lx-stat-icon-wrapper" style={{ background: 'rgba(245, 158, 11, 0.1)', color: 'var(--lx-amber)' }}>
            <AlertTriangle size={20} />
          </div>
          <div style={{ flex: 1 }}>
            <div className="lx-stat-label">Escalated to Human</div>
            <div className="lx-stat-val">{(stats?.escalated_leads ?? 0).toLocaleString()}</div>
            <div className="lx-stat-delta" style={{ color: 'var(--lx-amber)', fontSize: 11 }}>
              Requires Human Callback
            </div>
          </div>
        </div>
      </div>

      {/* Main Grid: Conversion Funnel & Live Activity */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 20 }}>
        {/* Qualification Funnel */}
        <div style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, padding: 22 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Conversion Funnel Stages</h3>
              <span style={{ fontSize: 12, color: 'var(--lx-muted)' }}>From raw ingest to qualified lead</span>
            </div>

          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {funnel.map((item, index) => (
              <div key={index}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ 
                      width: 20, 
                      height: 20, 
                      borderRadius: '50%', 
                      background: 'rgba(255,255,255,0.06)', 
                      display: 'inline-flex', 
                      alignItems: 'center', 
                      justifyContent: 'center', 
                      fontSize: 10.5, 
                      fontWeight: 700 
                    }}>
                      {index + 1}
                    </span>
                    <strong style={{ color: 'var(--lx-text)' }}>{item.stage}</strong>
                  </div>
                  <div style={{ display: 'flex', gap: 12 }}>
                    <span style={{ color: 'var(--lx-muted)' }}>{item.count.toLocaleString()} leads</span>
                    <strong style={{ color: 'var(--lx-accent)' }}>{item.percent}%</strong>
                  </div>
                </div>

                {/* Progress Track */}
                <div style={{ width: '100%', height: 8, background: 'rgba(255,255,255,0.04)', borderRadius: 4, overflow: 'hidden' }}>
                  <div 
                    style={{ 
                      width: `${item.percent}%`, 
                      height: '100%', 
                      background: index === funnel.length - 1 
                        ? 'linear-gradient(90deg, #6366f1, #22c55e)' 
                        : 'linear-gradient(90deg, #6366f1, #8b5cf6)',
                      borderRadius: 4,
                      transition: 'width 0.6s ease'
                    }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 24, paddingTop: 16, borderTop: '1px solid var(--lx-border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--lx-muted)' }}>
              Avg Call Duration: <strong style={{ color: 'var(--lx-text)' }}>{Math.floor((stats?.avg_duration ?? 0) / 60)}m {(stats?.avg_duration ?? 0) % 60}s</strong>
            </span>
            <button 
              type="button" 
              className="lx-btn lx-btn-small" 
              onClick={() => setActivePage('leads')}
            >
              Explore Leads Feed <ArrowRight size={13} style={{ display: 'inline', marginLeft: 4 }} />
            </button>
          </div>
        </div>

        {/* Live Call Telemetry & Activity */}
        <div style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, padding: 22, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div>
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>Live Telemetry Stream</h3>
              <span style={{ fontSize: 12, color: 'var(--lx-muted)' }}>Recent voice interactions & callbacks</span>
            </div>
            <button 
              type="button" 
              className="lx-btn lx-btn-small" 
              onClick={() => setActivePage('monitor')}
            >
              Monitor Live
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
            {([] as Array<{ name: string; phone: string; status: string; time: string; score: number; provider: string }>).map((lead, i) => (
              <div 
                key={i} 
                onClick={() => setSelectedLeadId(`lead_sample_${i}`)}
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'space-between', 
                  padding: '10px 12px', 
                  background: 'rgba(255,255,255,0.02)', 
                  border: '1px solid var(--lx-border)', 
                  borderRadius: 9,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease'
                }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--lx-text)' }}>{lead.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--lx-muted)', display: 'flex', gap: 8, marginTop: 2 }}>
                    <span>{lead.phone}</span>
                    <span>•</span>
                    <span>{lead.time}</span>
                    <span>•</span>
                    <span style={{ color: 'var(--lx-accent)' }}>{lead.provider}</span>
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className={`lx-badge ${lead.status === 'QUALIFIED' ? 'badge-green' : (lead.status === 'ESCALATED' ? 'badge-amber' : 'badge-gray')}`}>
                    {lead.status}
                  </span>
                  <div style={{ 
                    fontSize: 11, 
                    fontWeight: 700, 
                    color: lead.score >= 80 ? 'var(--lx-green)' : 'var(--lx-accent)',
                    background: 'rgba(255,255,255,0.05)',
                    padding: '2px 6px',
                    borderRadius: 5
                  }}>
                    {lead.score}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
