import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { Plug, CheckCircle2, Shield, RefreshCw, Key, ExternalLink } from 'lucide-react';

export const IntegrationsPage: React.FC = () => {
  const { activeTenant } = useAppStore();

  // Static placeholders. Wire these to GET /campaigns/configured-providers and
  // GET /integrations/webhooks when you build out this page.
  const voiceIntegrations = [
    {
      name: 'Gnani.ai Voice Agent',
      category: 'Conversational Voice AI',
      status: 'Add credentials (Super Admin → Voice Providers or .env)',
      authType: 'Encrypted per-tenant credentials (AES-256-GCM)',
      lastPing: '—'
    }
  ];

  const partnerIntegrations = [
    {
      name: 'Outgoing Webhooks',
      category: 'Partner Callback',
      status: 'Configure per tenant',
      endpoint: 'POST /integrations/webhooks',
      events: 'lead.scored, call events'
    }
  ];

  return (
    <div className="lx-page show">
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <Plug size={24} color="var(--lx-accent)" />
            API & Telephony Integrations Center
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Manage Encrypted Voice Credentials, Telephony SIP Trunks & Webhook Handshakes ({activeTenant.toUpperCase()})
          </span>
        </div>
      </div>

      <div style={{ marginBottom: 24 }}>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Telephony & Voice AI Backends</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 16 }}>
          {voiceIntegrations.map((v, i) => (
            <div key={i} style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{v.name}</h4>
                  <div style={{ fontSize: 11.5, color: 'var(--lx-muted)', marginTop: 2 }}>{v.category}</div>
                </div>
                <span className="lx-badge badge-green" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <CheckCircle2 size={12} /> {v.status}
                </span>
              </div>

              <div style={{ background: 'rgba(255,255,255,0.02)', padding: 12, borderRadius: 8, border: '1px solid var(--lx-border)', fontSize: 12, margin: '14px 0' }}>
                <div style={{ color: 'var(--lx-muted)', marginBottom: 4 }}>Authentication Protocol</div>
                <div style={{ fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Shield size={13} color="var(--lx-green)" /> {v.authType}
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11.5, color: 'var(--lx-muted)' }}>
                <span>Health check: {v.lastPing}</span>
                <span style={{ color: 'var(--lx-green)', fontWeight: 600 }}>Operational</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>Enterprise Partner Pipelines & CRM Sync</h3>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 16 }}>
          {partnerIntegrations.map((p, i) => (
            <div key={i} style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, padding: 20 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
                <div>
                  <h4 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{p.name}</h4>
                  <div style={{ fontSize: 11.5, color: 'var(--lx-muted)', marginTop: 2 }}>{p.category}</div>
                </div>
                <span className="lx-badge badge-green">{p.status}</span>
              </div>

              <div style={{ fontSize: 12, color: 'var(--lx-muted)', margin: '12px 0 6px', fontFamily: 'var(--lx-mono)' }}>
                Endpoint: {p.endpoint}
              </div>
              <div style={{ fontSize: 11, color: 'var(--lx-accent)', background: 'rgba(99,102,241,0.06)', padding: '6px 10px', borderRadius: 6 }}>
                Subscribed: {p.events}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
