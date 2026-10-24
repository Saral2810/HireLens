import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/api';
import { Campaign } from '../types';
import { 
  Target, 
  Plus, 
  Play, 
  Pause, 
  RefreshCw, 
  Layers, 
  PhoneOutgoing, 
  CheckCircle, 
  ArrowRightLeft 
} from 'lucide-react';

export const CampaignsPage: React.FC = () => {
  const { activeTenant, setCreateCampaignOpen, setSwitchProviderCampaign, addNotification } = useAppStore();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(false);

  const loadCampaigns = async () => {
    setLoading(true);
    try {
      const list = await api.getCampaigns();
      setCampaigns(list || []);
    } catch {
      setCampaigns([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCampaigns();
  }, [activeTenant]);

  const handleToggleStatus = async (c: Campaign) => {
    const nextStatus = c.status === 'active' ? 'paused' : 'active';
    try {
      await api.updateCampaign(c.id, { status: nextStatus });
      addNotification({
        title: 'Campaign Status Updated',
        message: `Campaign "${c.name}" is now ${nextStatus.toUpperCase()}.`,
        type: 'info'
      });
      loadCampaigns();
    } catch (e: any) {
      alert(e.message || 'Failed to update campaign status');
    }
  };

  const handleTriggerDial = async (c: Campaign) => {
    try {
      await api.triggerCampaignDial(c.id);
      addNotification({
        title: 'Batch Dialing Initiated',
        message: `Dispatcher started dialing leads for "${c.name}".`,
        type: 'success'
      });
    } catch (e: any) {
      alert(e.message || 'Failed to trigger batch dialer');
    }
  };

  return (
    <div className="lx-page show">
      {/* Title */}
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em' }}>
            Calling Campaigns & Voice Routing
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Manage Outbound Dialing Queues, Concurrency Quotas & Multi-Provider AI Runtimes ({activeTenant.toUpperCase()})
          </span>
        </div>

        <button 
          type="button" 
          className="lx-restored-btn primary" 
          onClick={() => setCreateCampaignOpen(true)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <Plus size={15} /> Create Campaign
        </button>
      </div>

      {/* Campaigns Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 16 }}>
        {campaigns.map((c) => {
          const qualRate = c.dialed_count ? Math.round(((c.qualified_count || 0) / c.dialed_count) * 100) : 0;
          return (
            <div 
              key={c.id} 
              style={{ 
                background: 'var(--lx-card)', 
                border: '1px solid var(--lx-border)', 
                borderRadius: 14, 
                padding: 20,
                display: 'flex',
                flexDirection: 'column'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--lx-text)' }}>{c.name}</h3>
                  <div style={{ fontSize: 11.5, color: 'var(--lx-muted)', marginTop: 2 }}>
                    Campaign ID: <code style={{ fontFamily: 'var(--lx-mono)' }}>{c.id}</code>
                  </div>
                </div>

                <span className={`lx-badge ${c.status === 'active' ? 'badge-green' : (c.status === 'paused' ? 'badge-amber' : 'badge-gray')}`}>
                  ● {c.status.toUpperCase()}
                </span>
              </div>

              {/* Voice Engine Tag & Concurrency */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                <span className="lx-badge badge-blue" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <Layers size={12} />
                  Engine: {c.voice_provider || 'gnani'}
                </span>
                <span className="lx-badge badge-gray">
                  Agent: {c.voice_agent_id}
                </span>
                <span className="lx-badge badge-gray">
                  Concurrency: {c.concurrency_limit || 5} calls
                </span>
              </div>

              {/* Progress Counters */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 10, border: '1px solid var(--lx-border)', marginBottom: 18 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--lx-muted)' }}>Total Leads</div>
                  <div style={{ fontSize: 15, fontWeight: 700, marginTop: 2 }}>{(c.total_leads || 0).toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--lx-muted)' }}>Dialed Calls</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lx-accent)', marginTop: 2 }}>{(c.dialed_count || 0).toLocaleString()}</div>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--lx-muted)' }}>Qualified Yield</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--lx-green)', marginTop: 2 }}>{qualRate}%</div>
                </div>
              </div>

              {/* Action Buttons */}
              <div style={{ marginTop: 'auto', display: 'flex', gap: 8, borderTop: '1px solid var(--lx-border)', paddingTop: 14 }}>
                <button 
                  type="button" 
                  className="lx-action-btn lx-action-btn--copy"
                  onClick={() => setSwitchProviderCampaign(c)}
                  title="Switch this campaign to another voice provider / agent"
                >
                  <ArrowRightLeft size={13} /> Switch Provider
                </button>

                <button 
                  type="button" 
                  className="lx-action-btn"
                  style={{ background: 'rgba(255,255,255,0.05)', color: 'var(--lx-text)', borderColor: 'var(--lx-border)' }}
                  onClick={() => handleToggleStatus(c)}
                >
                  {c.status === 'active' ? <Pause size={13} /> : <Play size={13} />}
                  {c.status === 'active' ? 'Pause' : 'Resume'}
                </button>

                <button 
                  type="button" 
                  className="lx-action-btn"
                  style={{ background: 'rgba(34, 197, 94, 0.1)', color: 'var(--lx-green)', borderColor: 'rgba(34, 197, 94, 0.25)', marginLeft: 'auto' }}
                  onClick={() => handleTriggerDial(c)}
                >
                  <PhoneOutgoing size={13} /> Trigger Dial
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
