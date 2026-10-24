import React, { useEffect, useState } from 'react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/api';
import { Users, Phone, Mic, Sparkles, CheckCircle2, Play } from 'lucide-react';

export const AgentsPage: React.FC = () => {
  const { activeTenant, addNotification } = useAppStore();
  const [testPhone, setTestPhone] = useState('');
  const [dialing, setDialing] = useState(false);
  const [activeModalAgent, setActiveModalAgent] = useState<string | null>(null);

  // Agents come from the backend (GET /admin/agents), which asks the voice provider adapter
  // (backend/src/services/voiceProvider/gnaniProvider.js -> getAgents()).
  const [agents, setAgents] = useState<Array<{ id: string; name: string; provider: string; language: string; voice: string; latency: string; description: string }>>([]);

  useEffect(() => {
    api.getAgents().then((list: any[]) => {
      setAgents((list || []).map((a: any) => ({
        id: a.id || a.agent_id,
        name: a.name || a.id,
        provider: a.provider_type || a.provider || 'gnani',
        language: a.language || '—',
        voice: a.voice || '—',
        latency: a.latency || '—',
        description: a.description || ''
      })));
    }).catch(() => setAgents([]));
  }, [activeTenant]);

  const handleTestCall = async (agentId: string) => {
    setDialing(true);
    try {
      const agent = agents.find(a => a.id === agentId);
      await api.triggerTestCall(testPhone, agentId, agent?.provider || 'gnani');
      addNotification({
        title: 'Test Call Dispatched',
        message: `Calling ${testPhone} with agent ${agentId}. Pick up to test live conversation.`,
        type: 'success'
      });
      setActiveModalAgent(null);
    } catch (err: any) {
      addNotification({
        title: 'Test Call Failed',
        message: err?.message || 'Could not place the test call.',
        type: 'error'
      });
    } finally {
      setDialing(false);
    }
  };

  return (
    <div className="lx-page show">
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Users size={24} color="var(--lx-accent)" />
            Conversational Voice AI Agents
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Manage Multi-Lingual Speech Synthesizers, Prompts & Live Test Calling ({activeTenant.toUpperCase()})
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 16 }}>
        {agents.map((agent) => (
          <div 
            key={agent.id}
            style={{ 
              background: 'var(--lx-card)', 
              border: '1px solid var(--lx-border)', 
              borderRadius: 14, 
              padding: 22,
              display: 'flex',
              flexDirection: 'column'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 14 }}>
              <div>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: 'var(--lx-text)' }}>{agent.name}</h3>
                <div style={{ fontSize: 11.5, color: 'var(--lx-muted)', fontFamily: 'var(--lx-mono)', marginTop: 2 }}>
                  {agent.id}
                </div>
              </div>
              <span className="lx-badge badge-blue">{agent.provider}</span>
            </div>

            <p style={{ fontSize: 12.5, color: 'var(--lx-muted)', lineHeight: 1.55, margin: '0 0 16px' }}>
              {agent.description}
            </p>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 10, border: '1px solid var(--lx-border)', marginBottom: 18, fontSize: 11.5 }}>
              <div>
                <div style={{ color: 'var(--lx-muted)' }}>Language</div>
                <div style={{ fontWeight: 600, color: 'var(--lx-text)', marginTop: 2 }}>{agent.language}</div>
              </div>
              <div>
                <div style={{ color: 'var(--lx-muted)' }}>Voice Model</div>
                <div style={{ fontWeight: 600, color: 'var(--lx-text)', marginTop: 2 }}>{agent.voice}</div>
              </div>
              <div>
                <div style={{ color: 'var(--lx-muted)' }}>Turn Latency</div>
                <div style={{ fontWeight: 700, color: 'var(--lx-green)', marginTop: 2 }}>{agent.latency}</div>
              </div>
            </div>

            <div style={{ marginTop: 'auto', display: 'flex', gap: 8, borderTop: '1px solid var(--lx-border)', paddingTop: 14 }}>
              <button 
                type="button" 
                className="lx-restored-btn primary"
                onClick={() => setActiveModalAgent(agent.id)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5 }}
              >
                <Phone size={13} /> Talk to Agent (Test Call)
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Test Call Modal */}
      {activeModalAgent && (
        <div className="lx-restored-modal show" onClick={(e) => { if (e.target === e.currentTarget) setActiveModalAgent(null); }}>
          <div className="lx-restored-box" style={{ maxWidth: 440 }}>
            <h3>Initiate Live Test Dial</h3>
            <p className="lx-restored-msg">
              The AI Voicebot will place a live phone call to test conversational quality, audio latency, and prompt accuracy.
            </p>
            <label>Destination Phone Number (E.164)</label>
            <input 
              type="text" 
              className="lx-input" 
              value={testPhone}
              onChange={(e) => setTestPhone(e.target.value)}
              placeholder="+91 98765 43210"
            />
            <div className="lx-restored-actions" style={{ marginTop: 20 }}>
              <button type="button" className="lx-restored-btn" onClick={() => setActiveModalAgent(null)}>Cancel</button>
              <button 
                type="button" 
                className="lx-restored-btn primary"
                onClick={() => handleTestCall(activeModalAgent)}
                disabled={dialing}
              >
                {dialing ? 'Connecting Telephony...' : 'Place Test Call Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
