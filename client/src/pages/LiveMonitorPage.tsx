import React, { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { api } from '../services/api';
import { 
  Radio, 
  PhoneCall, 
  Clock, 
  Activity, 
  ShieldCheck, 
  Mic, 
  Volume2, 
  PhoneOff, 
  Eye 
} from 'lucide-react';

interface ActiveCall {
  id: string;
  leadName: string;
  phone: string;
  provider: string;
  agentName: string;
  durationSeconds: number;
  latencyMs: number;
  status: 'connected' | 'dialing' | 'analyzing';
  lastUtterance: string;
}

export const LiveMonitorPage: React.FC = () => {
  const { activeTenant, setSelectedLeadId } = useAppStore();
  const [activeCalls, setActiveCalls] = useState<ActiveCall[]>([]);

  // Poll the backend for in-flight calls (GET /leads/active-sessions)
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const calls = await api.getLiveCalls();
      if (cancelled) return;
      setActiveCalls(calls.map((c: any) => ({
        id: c.session_id,
        leadName: c.lead_name || 'Unknown',
        phone: c.phone || '',
        provider: c.provider || 'gnani',
        agentName: c.agent_name || '—',
        durationSeconds: c.duration_seconds || 0,
        latencyMs: 0,
        status: c.status === 'in-progress' ? 'connected' : 'dialing',
        lastUtterance: ''
      })));
    };
    load();
    const poll = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(poll); };
  }, [activeTenant]);

  // Live timer tick
  useEffect(() => {
    const timer = setInterval(() => {
      setActiveCalls(prev => prev.map(c => ({
        ...c,
        durationSeconds: c.durationSeconds + 1
      })));
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="lx-page show">
      {/* Title */}
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Radio size={24} color="var(--lx-green)" style={{ animation: 'tenantPulse 2s infinite' }} />
            Live Voice Telemetry & Call Monitor
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Real-Time In-Flight Speech Dialogs, Webhook Health & Agent Turn Latencies ({activeTenant.toUpperCase()})
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="lx-badge badge-green" style={{ fontSize: 12, padding: '6px 12px' }}>
            ● {activeCalls.length} Active Sessions
          </span>
        </div>
      </div>

      {/* Real-Time Metrics Strip */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 20 }}>
        <div className="lx-stat">
          <div className="lx-stat-label">In-Flight Concurrency</div>
          <div className="lx-stat-val" style={{ color: 'var(--lx-green)' }}>{activeCalls.length} / 10</div>
          <div className="lx-stat-delta" style={{ color: 'var(--lx-muted)', fontSize: 11 }}>Quota allocated</div>
        </div>
        <div className="lx-stat">
          <div className="lx-stat-label">Speech Turn Latency</div>
          <div className="lx-stat-val" style={{ color: 'var(--lx-accent)' }}>—</div>
          <div className="lx-stat-delta" style={{ color: 'var(--lx-muted)', fontSize: 11 }}>Wire up from provider metrics</div>
        </div>
        <div className="lx-stat">
          <div className="lx-stat-label">Audio Packet Loss</div>
          <div className="lx-stat-val" style={{ color: 'var(--lx-text)' }}>—</div>
          <div className="lx-stat-delta" style={{ color: 'var(--lx-muted)', fontSize: 11 }}>Wire up from provider metrics</div>
        </div>
        <div className="lx-stat">
          <div className="lx-stat-label">Post-Call Webhook Latency</div>
          <div className="lx-stat-val" style={{ color: 'var(--lx-text)' }}>—</div>
          <div className="lx-stat-delta" style={{ color: 'var(--lx-muted)', fontSize: 11 }}>Outgoing webhooks</div>
        </div>
      </div>

      {/* Active Call Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
        {activeCalls.map((call) => (
          <div 
            key={call.id} 
            style={{ 
              background: 'var(--lx-card)', 
              border: '1px solid var(--lx-border)', 
              borderRadius: 14, 
              padding: 20,
              boxShadow: '0 8px 24px rgba(0,0,0,0.2)' 
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
              <div>
                <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: 'var(--lx-text)' }}>{call.leadName}</h4>
                <div style={{ fontSize: 11.5, color: 'var(--lx-muted)', fontFamily: 'var(--lx-mono)', marginTop: 2 }}>
                  {call.phone}
                </div>
              </div>

              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className={`lx-badge ${call.status === 'connected' ? 'badge-green' : 'badge-amber'}`}>
                  {call.status === 'connected' ? '● Live Dialog' : 'Dialing...'}
                </span>
                <span className="lx-badge badge-blue">
                  {call.provider}
                </span>
              </div>
            </div>

            {/* Live Timer & Agent */}
            <div style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(255,255,255,0.02)', padding: '10px 14px', borderRadius: 8, border: '1px solid var(--lx-border)', marginBottom: 14, fontSize: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Clock size={13} color="var(--lx-green)" />
                <span style={{ fontWeight: 700, color: 'var(--lx-green)', fontFamily: 'var(--lx-mono)' }}>
                  {formatDuration(call.durationSeconds)}
                </span>
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Activity size={13} color="var(--lx-accent)" />
                <span style={{ color: 'var(--lx-muted)' }}>Latency:</span>
                <strong style={{ color: 'var(--lx-text)' }}>{call.latencyMs} ms</strong>
              </div>
            </div>

            {/* Live Utterance Teaser */}
            <div style={{ background: 'rgba(99, 102, 241, 0.05)', border: '1px solid rgba(99, 102, 241, 0.2)', borderRadius: 8, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 10.5, color: 'var(--lx-accent)', fontWeight: 700, textTransform: 'uppercase', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 5 }}>
                <Mic size={12} /> Live ASR Transcription
              </div>
              <p style={{ margin: 0, fontSize: 12, fontStyle: 'italic', color: 'var(--lx-text)' }}>
                {call.lastUtterance}
              </p>
            </div>

            {/* Action Bar */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--lx-border)', paddingTop: 12 }}>
              <button 
                type="button" 
                className="lx-action-btn lx-action-btn--copy"
                onClick={() => setSelectedLeadId(call.id)}
              >
                <Eye size={13} /> View Live Brief
              </button>
              <button 
                type="button" 
                className="lx-action-btn lx-action-btn--delete"
                onClick={() => {
                  setActiveCalls(prev => prev.filter(c => c.id !== call.id));
                }}
              >
                <PhoneOff size={13} /> Terminate
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
