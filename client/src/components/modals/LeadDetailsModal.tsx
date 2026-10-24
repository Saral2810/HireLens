import React, { useState, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { api } from '../../services/api';
import { Lead } from '../../types';
import { 
  Sparkles, 
  X, 
  Phone, 
  Clock, 
  CheckCircle2, 
  AlertCircle, 
  Play, 
  Pause, 
  Volume2, 
  FileText, 
  ShieldCheck, 
  Activity 
} from 'lucide-react';

export const LeadDetailsModal: React.FC = () => {
  const { selectedLeadId, setSelectedLeadId } = useAppStore();
  const [lead, setLead] = useState<Lead | null>(null);
  const [loading, setLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1);
  const [activeTab, setActiveTab] = useState<'transcript' | 'telephony' | 'audit'>('transcript');

  useEffect(() => {
    if (!selectedLeadId) return;
    setLoading(true);
    api.getLeadDetails(selectedLeadId)
      .then(res => setLead(res))
      .catch(() => setLead(null))
      .finally(() => setLoading(false));
  }, [selectedLeadId]);

  if (!selectedLeadId) return null;

  return (
    <div 
      className="lx-restored-modal show" 
      onClick={(e) => {
        if (e.target === e.currentTarget) setSelectedLeadId(null);
      }}
    >
      <div className="lx-lead-details-box" style={{ maxWidth: 1050, width: '92vw' }}>
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18, borderBottom: '1px solid var(--lx-border)', paddingBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ 
              width: 38, 
              height: 38, 
              borderRadius: 10, 
              background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.2), rgba(139, 92, 246, 0.2))', 
              border: '1px solid rgba(99, 102, 241, 0.35)', 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'center', 
              color: 'var(--lx-accent)' 
            }}>
              <Sparkles size={18} />
            </div>
            <div>
              <h3 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: 'var(--lx-text)' }}>
                Lead Intelligence & Telephony Audit
              </h3>
              <span style={{ fontSize: 11.5, color: 'var(--lx-muted)' }}>
                Full contact profile, conversational transcript, and real-time AI scoring audit
              </span>
            </div>
          </div>

          <button 
            type="button" 
            className="lx-pwd-icon-btn" 
            style={{ padding: '6px 10px', cursor: 'pointer' }}
            onClick={() => setSelectedLeadId(null)}
          >
            <X size={16} />
          </button>
        </div>

        {loading || !lead ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--lx-muted)' }}>
            Loading lead intelligence data...
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '340px 1fr', gap: 20 }}>
            {/* Left Column: Lead Profile & Qualification Score */}
            <div style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid var(--lx-border)', borderRadius: 12, padding: 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <div style={{ 
                  width: 44, 
                  height: 44, 
                  borderRadius: '50%', 
                  background: 'linear-gradient(135deg,#6366f1,#8b5cf6)', 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  color: '#fff', 
                  fontWeight: 700, 
                  fontSize: 16 
                }}>
                  {lead.name.charAt(0)}
                </div>
                <div>
                  <h4 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{lead.name}</h4>
                  <div style={{ fontSize: 12, color: 'var(--lx-muted)', display: 'flex', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <Phone size={12} /> {lead.phone}
                  </div>
                </div>
              </div>

              {/* Status & Score Pills */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
                <span className={`lx-badge ${lead.status === 'QUALIFIED' ? 'badge-green' : 'badge-amber'}`} style={{ fontWeight: 700 }}>
                  ● {lead.status}
                </span>
                <span className="lx-badge badge-blue">
                  AI Score: {lead.lead_score}/100
                </span>
              </div>

              {/* Score Bar Meter */}
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, marginBottom: 6 }}>
                  <span style={{ color: 'var(--lx-muted)' }}>Conversion Propensity</span>
                  <strong style={{ color: 'var(--lx-green)' }}>{lead.lead_score}% High</strong>
                </div>
                <div style={{ width: '100%', height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ 
                    width: `${lead.lead_score}%`, 
                    height: '100%', 
                    background: 'linear-gradient(90deg, #6366f1, #22c55e)',
                    borderRadius: 3 
                  }}></div>
                </div>
              </div>

              {/* AI Summary Box */}
              <div style={{ background: 'rgba(99, 102, 241, 0.05)', border: '1px solid rgba(99, 102, 241, 0.2)', borderRadius: 10, padding: 12, marginBottom: 16 }}>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--lx-accent)', fontWeight: 700, marginBottom: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Sparkles size={13} /> AI Executive Summary
                </div>
                <p style={{ fontSize: 12, lineHeight: 1.55, margin: 0, color: 'var(--lx-text)' }}>
                  {lead.ai_summary}
                </p>
              </div>

              {/* Qualification Criteria Audit */}
              <div>
                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em', color: 'var(--lx-muted)', fontWeight: 700, marginBottom: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <ShieldCheck size={13} /> Decision Rule Audit
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {(lead.qualification_reasons || []).map((reason, idx) => (
                    <div key={idx} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 11.5, color: 'var(--lx-text)' }}>
                      <CheckCircle2 size={14} color="var(--lx-green)" style={{ flexShrink: 0, marginTop: 2 }} />
                      <span>{reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right Column: Audio Player & Live Transcript */}
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              {/* Audio Player Strip */}
              <div style={{ 
                background: 'rgba(255,255,255,0.03)', 
                border: '1px solid var(--lx-border)', 
                borderRadius: 12, 
                padding: '12px 18px', 
                marginBottom: 14,
                display: 'flex',
                alignItems: 'center',
                gap: 14
              }}>
                <button 
                  type="button" 
                  onClick={() => setIsPlaying(!isPlaying)}
                  style={{ 
                    width: 36, 
                    height: 36, 
                    borderRadius: '50%', 
                    background: 'var(--lx-accent)', 
                    border: 'none', 
                    color: '#fff', 
                    display: 'flex', 
                    alignItems: 'center', 
                    justifyContent: 'center',
                    cursor: 'pointer' 
                  }}
                >
                  {isPlaying ? <Pause size={16} /> : <Play size={16} style={{ marginLeft: 2 }} />}
                </button>

                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--lx-muted)', marginBottom: 4 }}>
                    <span>0:32 / 2:22</span>
                    <span>Call recording</span>
                  </div>
                  {/* Fake Audio Waveform / Scrubber */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3, height: 22, cursor: 'pointer' }}>
                    {[12, 18, 8, 22, 16, 26, 14, 19, 24, 10, 15, 20, 25, 12, 17, 21, 16, 14, 22, 18, 24, 15, 12, 8, 16, 20, 14].map((h, i) => (
                      <div 
                        key={i} 
                        style={{ 
                          width: 4, 
                          height: h, 
                          borderRadius: 2, 
                          background: i < 12 ? 'var(--lx-accent)' : 'rgba(255,255,255,0.15)' 
                        }}
                      />
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <button 
                    type="button"
                    className="lx-btn lx-btn-small" 
                    onClick={() => setPlaybackSpeed(playbackSpeed === 1 ? 1.5 : (playbackSpeed === 1.5 ? 2 : 1))}
                    style={{ fontSize: 11, padding: '4px 8px' }}
                  >
                    {playbackSpeed}x
                  </button>
                  <Volume2 size={16} color="var(--lx-muted)" />
                </div>
              </div>

              {/* Tabs for Transcript vs Telephony */}
              <div style={{ display: 'flex', gap: 8, borderBottom: '1px solid var(--lx-border)', paddingBottom: 6, marginBottom: 12 }}>
                <button 
                  type="button"
                  className={`lx-restored-btn ${activeTab === 'transcript' ? 'active' : ''}`}
                  onClick={() => setActiveTab('transcript')}
                  style={{ border: 'none', background: activeTab === 'transcript' ? 'rgba(99,102,241,0.15)' : 'transparent', color: activeTab === 'transcript' ? 'var(--lx-accent)' : 'var(--lx-muted)' }}
                >
                  <FileText size={14} style={{ display: 'inline', marginRight: 6 }} /> Transcript Turns ({lead.transcript?.length || 0})
                </button>
                <button 
                  type="button"
                  className={`lx-restored-btn ${activeTab === 'telephony' ? 'active' : ''}`}
                  onClick={() => setActiveTab('telephony')}
                  style={{ border: 'none', background: activeTab === 'telephony' ? 'rgba(99,102,241,0.15)' : 'transparent', color: activeTab === 'telephony' ? 'var(--lx-accent)' : 'var(--lx-muted)' }}
                >
                  <Activity size={14} style={{ display: 'inline', marginRight: 6 }} /> Telephony Latency Audit
                </button>
              </div>

              {/* Transcript Bubbles */}
              {activeTab === 'transcript' ? (
                <div style={{ flex: 1, maxHeight: 360, overflowY: 'auto', paddingRight: 8, display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {(lead.transcript || []).map((turn, i) => (
                    <div 
                      key={i} 
                      style={{ 
                        alignSelf: turn.speaker === 'agent' ? 'flex-start' : 'flex-end',
                        maxWidth: '82%',
                        background: turn.speaker === 'agent' ? 'rgba(255,255,255,0.04)' : 'rgba(99, 102, 241, 0.15)',
                        border: turn.speaker === 'agent' ? '1px solid var(--lx-border)' : '1px solid rgba(99, 102, 241, 0.3)',
                        borderRadius: 12,
                        padding: '10px 14px'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10.5, color: 'var(--lx-muted)', marginBottom: 4, gap: 12 }}>
                        <strong style={{ color: turn.speaker === 'agent' ? 'var(--lx-accent)' : '#a5b4fc' }}>
                          {turn.speaker === 'agent' ? 'AI Voicebot' : 'Customer'}
                        </strong>
                        <span>{turn.time}</span>
                      </div>
                      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--lx-text)' }}>
                        {turn.text}
                      </p>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ flex: 1, maxHeight: 360, overflowY: 'auto', fontSize: 12 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12, marginBottom: 16 }}>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid var(--lx-border)' }}>
                      <div style={{ color: 'var(--lx-muted)', fontSize: 11 }}>Voice Engine</div>
                      <div style={{ fontWeight: 600, marginTop: 4 }}>{(lead as any)?.voice_provider || 'gnani'}</div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid var(--lx-border)' }}>
                      <div style={{ color: 'var(--lx-muted)', fontSize: 11 }}>SIP Endpoint Round-Trip</div>
                      <div style={{ fontWeight: 600, marginTop: 4 }}>—</div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid var(--lx-border)' }}>
                      <div style={{ color: 'var(--lx-muted)', fontSize: 11 }}>Call Session Duration</div>
                      <div style={{ fontWeight: 600, marginTop: 4 }}>{(lead as any)?.duration_seconds ?? 0} seconds</div>
                    </div>
                    <div style={{ background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid var(--lx-border)' }}>
                      <div style={{ color: 'var(--lx-muted)', fontSize: 11 }}>Outgoing Webhook</div>
                      <div style={{ fontWeight: 600, marginTop: 4 }}>—</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
