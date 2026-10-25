import React from 'react';
import { PhoneCall } from 'lucide-react';

// Bar heights for the waveform (fixed, so the card looks the same on every render).
const WAVE = [6, 12, 20, 14, 26, 18, 30, 22, 12, 8, 16, 28, 20, 10, 24, 30, 18, 12, 22, 14, 8, 18, 26, 16, 10, 20, 28, 14, 8, 12, 22, 18, 10, 6];

/** A sample screening call, shown on the landing and sign-in pages. Made-up content. */
export const CallPreview: React.FC = () => (
  <div className="call-card" aria-label="Example screening call">
    <div className="call-card-head">
      <span className="call-card-icon"><PhoneCall size={16} /></span>
      <div className="grow">
        <div className="strong" style={{ fontSize: 14 }}>Backend Engineer screening</div>
        <div className="label">Asha R. · Question 4 of 9</div>
      </div>
      <span className="badge badge-solid badge-live">Live</span>
      <span className="label">03:12</span>
    </div>
    <div className="wave" aria-hidden="true">
      {WAVE.map((h, i) => <i key={i} style={{ height: h, animationDelay: `${(i % 7) * 0.12}s` }} />)}
      <span className="tag spacer">hi-IN / en-IN</span>
    </div>
    <div className="call-card-body">
      <div>
        <div className="label">Agent · replied in 0.9 s</div>
        <div className="bubble bubble-agent" style={{ marginTop: 4 }}>Aapka current notice period kitna hai?</div>
      </div>
      <div style={{ alignSelf: 'flex-end', maxWidth: '85%' }}>
        <div className="label" style={{ textAlign: 'right' }}>Asha · en-IN</div>
        <div className="bubble bubble-you" style={{ marginTop: 4, maxWidth: '100%' }}>Do mahine ka hai, but I can try to join earlier.</div>
      </div>
      <div>
        <div className="label">Saved</div>
        <div className="row-wrap mt-sm" style={{ gap: 6 }}>
          <span className="tag">notice_period: 60 days</span>
          <span className="tag">fit_score: 78</span>
        </div>
      </div>
    </div>
    <div className="call-card-foot">
      <div><div className="label">Avg reply</div><div className="mono strong" style={{ fontSize: 13 }}>0.9 s</div></div>
      <div><div className="label">Languages</div><div className="mono strong" style={{ fontSize: 13 }}>Hindi, English</div></div>
      <div><div className="label">Recording</div><div className="mono strong" style={{ fontSize: 13 }}>On</div></div>
    </div>
  </div>
);
