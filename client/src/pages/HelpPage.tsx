import React from 'react';
import { BookOpen, Shield, PhoneCall, Cpu, ArrowRight } from 'lucide-react';

export const HelpPage: React.FC = () => {
  const glossary = [
    {
      term: 'Multi-Provider Voice Abstraction',
      desc: 'Telephony execution is decoupled from voice intelligence. Each campaign picks a voice provider adapter (Gnani by default); add more adapters in backend/src/services/voiceProvider/.'
    },
    {
      term: 'Anti-Wedge Dialer Safety',
      desc: 'A Promise.race polling loop guard prevents dispatcher deadlocks by capping ticks to 30 seconds and automatically reversing false-failure statuses if late webhooks arrive.'
    },
    {
      term: 'Relational Campaign Isolation (lead_campaigns)',
      desc: 'Leads have attempt counters and statuses scoped per campaign. A lead exhausted in one campaign is not burned for subsequent campaigns.'
    },
    {
      term: 'Enterprise Partner Callback Pipeline',
      desc: 'Asynchronous outgoing webhooks (Integrations → Webhooks) report call outcomes and lead scores to your downstream systems.'
    }
  ];

  return (
    <div className="lx-page show">
      <div className="lx-section-title" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 18 }}>
        <div>
          <span className="gradient-text lx-h1" style={{ fontSize: 24, fontWeight: 800, letterSpacing: '-0.02em', display: 'flex', alignItems: 'center', gap: 10 }}>
            <BookOpen size={24} color="var(--lx-accent)" />
            Documentation & Glossary
          </span>
          <span className="sub lx-muted-text" style={{ fontSize: 13, display: 'block', marginTop: 2 }}>
            Platform Terminology, Telephony Architecture & Keyboard Shortcuts
          </span>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(460px, 1fr))', gap: 16 }}>
        {glossary.map((item, i) => (
          <div key={i} style={{ background: 'var(--lx-card)', border: '1px solid var(--lx-border)', borderRadius: 14, padding: 20 }}>
            <h4 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 700, color: 'var(--lx-accent)' }}>
              {item.term}
            </h4>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'var(--lx-muted)' }}>
              {item.desc}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};
