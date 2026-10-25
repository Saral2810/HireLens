import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BarChart3, FileSpreadsheet, FileText, Languages, Mic, ShieldCheck } from 'lucide-react';
import { Brand, ThemeToggle } from '../../components/layout/AppHeader';
import { CallPreview } from '../../components/public/CallPreview';

const STEPS = [
  { n: '01', title: 'Create a campaign', text: 'Pick the job role, keep or edit the HR questions, and add candidates from Excel or by hand.' },
  { n: '02', title: 'Run it', text: 'Candidates sign in with Google or an email code, upload a resume and check their mic.' },
  { n: '03', title: 'The agent calls', text: 'A five-minute voice call in English, Hindi or Hinglish: questions about their resume, then yours.' },
  { n: '04', title: 'Review results', text: 'Notice period, CTC, a summary, a fit score, the transcript and the recording, ready to export.' }
];

const FEATURES = [
  { icon: <Mic size={18} />, title: 'Natural voice calls', text: 'Gnani Prisma listens and Gnani Timbre speaks, in the browser. No phone line needed.' },
  { icon: <Languages size={18} />, title: 'English, Hindi, Hinglish', text: 'Candidates answer the way they talk. "Nau lakh" becomes 9 LPA.' },
  { icon: <FileText size={18} />, title: 'Questions from the resume', text: 'Three to five questions about each candidate\'s own projects before the HR questions.' },
  { icon: <FileSpreadsheet size={18} />, title: 'Excel in, Excel out', text: 'Upload a sheet of candidates; download every answer as CSV or Excel.' },
  { icon: <BarChart3 size={18} />, title: 'Campaign analytics', text: 'Completion, fit scores and calls per day across every campaign.' },
  { icon: <ShieldCheck size={18} />, title: 'Roles and privacy', text: 'Admin, recruiter and candidate access are separate. Recordings stay private.' }
];

/** Public landing page (signed-out visitors). */
export const LandingPage: React.FC = () => (
  <div className="public">
    <header className="public-nav">
      <Brand sub={false} />
      <a className="plain hide-sm" href="#how">How it works</a>
      <a className="plain hide-sm" href="#features">Features</a>
      <div className="row spacer">
        <ThemeToggle />
        <Link to="/login" className="btn btn-ghost">Sign in</Link>
        <Link to="/login?as=hr" className="btn btn-primary hide-sm">Get started</Link>
      </div>
    </header>

    <div className="dots">
      <section className="hero-grid">
        <div>
          <span className="eyebrow">AI screening calls · Gnani Prisma + Timbre</span>
          <h1 className="display">First-round HR calls, done by an agent that sounds human.</h1>
          <p className="lead">
            Add a batch of candidates and run the campaign. Each one takes a short voice call in English or Hindi,
            and you get structured answers, a summary, a fit score and the recording.
          </p>
          <div className="row-wrap mt-lg" style={{ gap: 10 }}>
            <Link to="/login?as=hr" className="btn btn-primary btn-lg">Get started <ArrowRight size={16} /></Link>
            <Link to="/login?as=candidate" className="btn btn-lg">I'm a candidate</Link>
          </div>
        </div>
        <CallPreview />
      </section>
    </div>

    <section className="section" id="how">
      <span className="eyebrow">How it works</span>
      <h2>From a spreadsheet of names to scored screening calls in an afternoon.</h2>
      <div className="steps-grid">
        {STEPS.map(s => (
          <div key={s.n} className="card card-pad">
            <div className="label">{s.n}</div>
            <h3 className="mt-sm">{s.title}</h3>
            <p className="muted small mt-sm" style={{ lineHeight: 1.6 }}>{s.text}</p>
          </div>
        ))}
      </div>
    </section>

    <section className="section" id="features">
      <span className="eyebrow">Features</span>
      <h2>Everything a first-round screen needs, already wired.</h2>
      <div className="feature-grid">
        {FEATURES.map(f => (
          <div key={f.title} className="card card-pad">
            <div className="empty-icon" style={{ margin: 0, width: 38, height: 38 }}>{f.icon}</div>
            <h3 className="mt">{f.title}</h3>
            <p className="muted small mt-sm" style={{ lineHeight: 1.6 }}>{f.text}</p>
          </div>
        ))}
      </div>
    </section>

    <section className="section" style={{ textAlign: 'center' }}>
      <h2 style={{ margin: '0 auto' }}>Screen your next batch today.</h2>
      <div className="row-wrap mt-lg" style={{ justifyContent: 'center', gap: 10 }}>
        <Link to="/login?as=hr" className="btn btn-primary btn-lg">Sign in as HR</Link>
        <Link to="/login?as=candidate" className="btn btn-lg">Sign in as a candidate</Link>
      </div>
    </section>

    <footer className="footer">
      <span>HR Screening · built on Gnani speech models</span>
      <span className="spacer">Demo with made-up candidates only</span>
    </footer>
  </div>
);
