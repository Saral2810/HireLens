import React, { useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/api';
import { Target, X } from 'lucide-react';

export const CreateCampaignModal: React.FC<{ onCreated?: () => void }> = ({ onCreated }) => {
  const { createCampaignOpen, setCreateCampaignOpen, activeTenant, addNotification } = useAppStore();
  const [name, setName] = useState('');
  const [voiceProvider, setVoiceProvider] = useState<string>('gnani');
  const [voiceAgentId, setVoiceAgentId] = useState('');
  const [concurrency, setConcurrency] = useState<number>(5);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!createCampaignOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Campaign name is required');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await api.createCampaign({
        name: name.trim(),
        voice_provider: voiceProvider,
        voice_agent_id: voiceAgentId,
        concurrency_limit: concurrency,
        status: 'draft',
        tenant_id: activeTenant
      });

      addNotification({
        title: 'Campaign Created',
        message: `Campaign "${name}" created successfully under ${activeTenant}.`,
        type: 'success'
      });

      setCreateCampaignOpen(false);
      setName('');
      if (onCreated) onCreated();
    } catch (err: any) {
      setError(err.message || 'Failed to create campaign');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div 
      className="lx-restored-modal show" 
      onClick={(e) => {
        if (e.target === e.currentTarget) setCreateCampaignOpen(false);
      }}
    >
      <div className="lx-restored-box" style={{ maxWidth: 480 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Target size={18} color="var(--lx-accent)" />
            Create Calling Campaign
          </h3>
          <button 
            type="button" 
            className="lx-pwd-icon-btn" 
            onClick={() => setCreateCampaignOpen(false)}
          >
            <X size={15} />
          </button>
        </div>

        <p className="lx-restored-msg">
          Configure a new outbound dialing campaign for workspace: <strong style={{ color: 'var(--lx-accent)' }}>{activeTenant}</strong>
        </p>

        {error && (
          <div style={{ background: 'rgba(239, 68, 68, 0.12)', border: '1px solid rgba(239, 68, 68, 0.3)', borderRadius: 8, padding: '10px 12px', color: '#fca5a5', fontSize: 12, marginBottom: 16 }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <label>Campaign Name</label>
          <input 
            type="text" 
            className="lx-input" 
            placeholder="e.g. Q4 Outreach Batch 1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />

          <label>Voice AI Provider</label>
          <select 
            className="lx-input" 
            value={voiceProvider}
            onChange={(e) => {
              setVoiceProvider(e.target.value);
            }}
          >
            <option value="gnani">Gnani.ai</option>
            <option value="mock">Mock (offline testing)</option>
          </select>

          <label>Voice Agent ID</label>
          <input 
            type="text" 
            className="lx-input" 
            value={voiceAgentId}
            onChange={(e) => setVoiceAgentId(e.target.value)}
            placeholder="Your Gnani agent ID"
            required
          />

          <label>Dialer Concurrency Limit</label>
          <select 
            className="lx-input" 
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
          >
            <option value="1">1 Concurrent Call (Safe / Debug)</option>
            <option value="3">3 Concurrent Calls</option>
            <option value="5">5 Concurrent Calls (Standard)</option>
            <option value="10">10 Concurrent Calls (High Throughput)</option>
            <option value="20">20 Concurrent Calls (Enterprise Surge)</option>
          </select>

          <div className="lx-restored-actions" style={{ marginTop: 24 }}>
            <button 
              type="button" 
              className="lx-restored-btn" 
              onClick={() => setCreateCampaignOpen(false)}
            >
              Cancel
            </button>
            <button 
              type="submit" 
              className="lx-restored-btn primary"
              disabled={loading}
            >
              {loading ? 'Creating...' : 'Create Campaign'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
