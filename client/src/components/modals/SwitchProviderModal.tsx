import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/api';
import { RefreshCw, X, AlertTriangle, CheckCircle } from 'lucide-react';

export const SwitchProviderModal: React.FC = () => {
  const { switchProviderCampaign, setSwitchProviderCampaign, addNotification } = useAppStore();
  const [providerType, setProviderType] = useState<string>('gnani');
  const [agentId, setAgentId] = useState<string>('');
  const [drainQueue, setDrainQueue] = useState<boolean>(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!switchProviderCampaign) return null;

  const handleSwitch = async () => {
    setLoading(true);
    setError(null);
    try {
      await api.switchProvider(switchProviderCampaign.id, {
        new_provider_type: providerType,
        new_voice_agent_id: agentId,
        drain: drainQueue
      });
      addNotification({
        title: 'Provider Switched Successfully',
        message: `Campaign "${switchProviderCampaign.name}" routed to ${providerType.toUpperCase()} (${agentId}).`,
        type: 'success'
      });
      setSwitchProviderCampaign(null);
    } catch (err: any) {
      setError(err.message || 'Failed to switch voice provider');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="lx-restored-modal show" 
      onClick={(e) => {
        if (e.target === e.currentTarget) setSwitchProviderCampaign(null);
      }}
    >
      <div className="lx-restored-box" style={{ maxWidth: 520 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <RefreshCw size={18} color="var(--lx-accent)" />
            Zero-Downtime Voice Provider Switcher
          </h3>
          <button 
            type="button" 
            className="lx-pwd-icon-btn" 
            onClick={() => setSwitchProviderCampaign(null)}
          >
            <X size={15} />
          </button>
        </div>

        <p className="lx-restored-msg">
          Switch active telephony runtime for campaign: <strong style={{ color: 'var(--lx-accent)' }}>{switchProviderCampaign.name}</strong>
        </p>

        {error && (
          <div style={{ background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, padding: '10px 12px', color: '#fca5a5', fontSize: 12, marginBottom: 16 }}>
            <AlertTriangle size={14} style={{ display: 'inline', marginRight: 6 }} />
            {error}
          </div>
        )}

        <label>Select Target Voice Engine</label>
        <select 
          className="lx-input" 
          value={providerType} 
          onChange={(e) => {
            const p = e.target.value;
            setProviderType(p);
          }}
        >
          <option value="gnani">Gnani.ai</option>
          <option value="mock">Mock (offline testing)</option>
        </select>

        <label>Target Voice Agent ID</label>
        <input 
          type="text" 
          className="lx-input" 
          value={agentId} 
          onChange={(e) => setAgentId(e.target.value)}
          placeholder="Your Gnani agent ID"
        />

        {/* Safety Drain Checkbox */}
        <div style={{ marginTop: 18, background: 'rgba(255,255,255,0.02)', border: '1px solid var(--lx-border)', borderRadius: 8, padding: 12 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', margin: 0, textTransform: 'none', color: 'var(--lx-text)', fontWeight: 500, fontSize: 13 }}>
            <input 
              type="checkbox" 
              checked={drainQueue} 
              onChange={(e) => setDrainQueue(e.target.checked)} 
              style={{ width: 16, height: 16, cursor: 'pointer' }}
            />
            <span>Safely drain pending dial queue (recommended)</span>
          </label>
          <div style={{ fontSize: 11, color: 'var(--lx-muted)', marginTop: 4, paddingLeft: 24 }}>
            Prevents in-flight call collisions by canceling stale dials from the previous provider before routing next batch.
          </div>
        </div>

        <div className="lx-restored-actions" style={{ marginTop: 22 }}>
          <button 
            type="button" 
            className="lx-restored-btn" 
            onClick={() => setSwitchProviderCampaign(null)}
          >
            Cancel
          </button>
          <button 
            type="button" 
            className="lx-restored-btn primary" 
            onClick={handleSwitch}
            disabled={loading}
          >
            {loading ? 'Switching...' : 'Switch Provider Now'}
          </button>
        </div>
      </div>
    </div>
  );
};
