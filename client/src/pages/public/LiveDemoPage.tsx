import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, Mail, Mic, Pause, Play, RotateCcw, Trophy, Upload, Users } from 'lucide-react';
import { Brand, ThemeToggle } from '../../components/layout/AppHeader';
import { buildDemoScript, CALL_QUESTIONS, DemoCandidate, DemoStage, scriptLength, stateAt } from '../../lib/liveDemo';

const SPEEDS = [1, 2, 4] as const;
const TICK_MS = 200;
// After the last event the finished dashboard stays up this long, then the demo starts again.
const HOLD_AT_END_S = 10;

const COLUMNS: { title: string; stages: DemoStage[] }[] = [
  { title: 'Invited', stages: ['added', 'invited'] },
  { title: 'Resume in', stages: ['resume', 'ready'] },
  { title: 'On a call', stages: ['on_call', 'dropped'] },
  { title: 'Completed', stages: ['completed'] }
];

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const CandidateCard: React.FC<{ c: DemoCandidate }> = ({ c }) => (
  <div className={`demo-card${c.stage === 'on_call' ? ' demo-card-live' : ''}`}>
    <div className="row small"><strong className="grow">{c.name}</strong><span className="tiny muted">{c.city}</span></div>
    <div className="row-wrap tiny mt-sm" style={{ gap: 6 }}>
      <span className="tag">{c.language}</span>
      {c.ats !== null && <span className="tag">ATS {c.ats}</span>}
      {c.fit !== null && <span className="tag tag-strong">Fit {c.fit}</span>}
      {c.fresher && c.stage !== 'added' && c.stage !== 'invited' && <span className="tag">Fresher</span>}
    </div>
    {c.stage === 'on_call' && (
      <div className="mt-sm">
        <div className="progress"><div style={{ width: `${(c.question / CALL_QUESTIONS) * 100}%` }} /></div>
        <div className="tiny muted mt-sm">Question {Math.max(1, c.question)} of {CALL_QUESTIONS}</div>
      </div>
    )}
    {c.stage === 'dropped' && <div className="tiny mt-sm">Call dropped: retrying…</div>}
  </div>
);

/**
 * /live — a public, self-running demo of a HireLens campaign with made-up candidates. Nothing here
 * talks to the server. Add ?embed=1 to drop the page header when it is shown inside another website.
 */
export const LiveDemoPage: React.FC = () => {
  const [params] = useSearchParams();
  const embed = params.get('embed') === '1';
  const script = useMemo(buildDemoScript, []);
  const length = scriptLength(script);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const chatBox = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(() => setT(prev => (prev >= length + HOLD_AT_END_S ? 0 : prev + (TICK_MS / 1000) * speed)), TICK_MS);
    return () => clearInterval(timer);
  }, [playing, speed, length]);

  const state = useMemo(() => stateAt(script, t), [script, t]);
  const lineCount = state.spotlight?.lines.length ?? 0;
  // Only the chat box scrolls to its newest line; the page itself never moves (it may be embedded).
  useEffect(() => { if (chatBox.current) chatBox.current.scrollTop = chatBox.current.scrollHeight; }, [lineCount]);

  const shortlist = state.candidates.filter(c => c.fit !== null).sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0));
  const s = state.stats;
  const KPIS = [
    { icon: <Users size={15} />, label: 'Candidates', value: s.total },
    { icon: <Mail size={15} />, label: 'Invites emailed', value: s.emailed },
    { icon: <Upload size={15} />, label: 'Resumes in', value: s.resumes },
    { icon: <Mic size={15} />, label: 'On a call now', value: s.onCall },
    { icon: <Trophy size={15} />, label: 'Completed', value: s.completed },
    { icon: <Activity size={15} />, label: 'Average fit', value: s.avgFit ?? '—' },
    { icon: <Activity size={15} />, label: 'Average ATS', value: s.avgAts ?? '—' }
  ];

  return (
    <div className={`public demo${embed ? ' demo-embed' : ''}`}>
      {!embed && (
        <header className="public-nav">
          <Brand sub={false} />
          <div className="row spacer">
            <ThemeToggle />
            <Link to="/login?as=hr" className="btn btn-primary">Get started</Link>
          </div>
        </header>
      )}

      <div className="demo-body">
        <div className="row-wrap" style={{ gap: 12, alignItems: 'center' }}>
          <div className="grow">
            <div className="row" style={{ gap: 8 }}>
              <span className={`live-dot${state.phase === 'running' ? ' on' : ''}`} aria-hidden="true" />
              <span className="eyebrow" style={{ margin: 0 }}>{state.phase === 'setup' ? 'Setting up' : state.phase === 'running' ? 'Live campaign' : 'Campaign finished'}</span>
            </div>
            <h1 className="demo-title">{state.campaign.name}</h1>
            <p className="small muted">{state.campaign.role} · {state.campaign.company} · simulated with made-up candidates</p>
          </div>
          <div className="row demo-controls" role="group" aria-label="Demo controls">
            <button className="btn btn-sm" onClick={() => setPlaying(p => !p)} aria-label={playing ? 'Pause the demo' : 'Play the demo'}>
              {playing ? <Pause size={14} /> : <Play size={14} />} {playing ? 'Pause' : 'Play'}
            </button>
            {SPEEDS.map(x => (
              <button key={x} className={`btn btn-sm${speed === x ? ' btn-primary' : ''}`} aria-pressed={speed === x} onClick={() => setSpeed(x)}>{x}×</button>
            ))}
            <button className="btn btn-sm" onClick={() => { setT(0); setPlaying(true); }} aria-label="Restart the demo"><RotateCcw size={14} /></button>
            <span className="tiny muted mono" aria-label="Demo time">{fmt(Math.min(t, length))} / {fmt(length)}</span>
          </div>
        </div>

        <div className="demo-kpis">
          {KPIS.map(k => (
            <div key={k.label} className="stat">
              <div className="stat-label row" style={{ gap: 6 }}>{k.icon}{k.label}</div>
              <div className="stat-value" aria-live="polite">{k.value}</div>
            </div>
          ))}
        </div>

        <div className="demo-grid">
          <section className="card card-pad demo-board" aria-label="Candidate pipeline">
            <h4 className="mb">Pipeline</h4>
            <div className="demo-columns">
              {COLUMNS.map(col => {
                const list = state.candidates.filter(c => col.stages.includes(c.stage));
                return (
                  <div key={col.title} className="demo-column">
                    <div className="row tiny muted mb-sm"><span className="grow">{col.title}</span><span className="mono">{list.length}</span></div>
                    {list.map(c => <CandidateCard key={c.id} c={c} />)}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="card card-pad demo-call" aria-label="Call in progress">
            <div className="row mb-sm">
              <h4 className="grow">{state.spotlight ? `Listening in: ${state.spotlight.name}` : 'Voice calls'}</h4>
              {state.spotlight && !state.spotlight.done && <span className="tag tag-strong">Live</span>}
            </div>
            {!state.spotlight && <p className="small muted">Calls appear here as candidates start them: an Indian voice agent asks about their projects, their resume and the HR questions.</p>}
            {state.spotlight && (
              <>
                <div className="progress mb-sm"><div style={{ width: `${(state.spotlight.question / state.spotlight.total) * 100}%` }} /></div>
                <div className="chat demo-chat" ref={chatBox}>
                  {state.spotlight.lines.map((l, i) => (
                    <div key={i} className={`bubble ${l.who === 'agent' ? 'bubble-agent' : 'bubble-you'}`}>
                      <div className="bubble-who">{l.who === 'agent' ? 'Voice agent' : state.spotlight!.name}</div>
                      {l.text}
                    </div>
                  ))}
                </div>
              </>
            )}
          </section>

          <section className="card card-pad demo-feed" aria-label="Activity">
            <h4 className="mb-sm">Activity</h4>
            <ol className="demo-feed-list">
              {state.feed.map((f, i) => <li key={`${f.t}-${i}`}><span className="mono tiny muted">{fmt(f.t)}</span> {f.text}</li>)}
            </ol>
          </section>

          <section className="card card-pad demo-shortlist" aria-label="Shortlist">
            <h4 className="mb-sm">Shortlist by fit score</h4>
            {shortlist.length === 0 && <p className="small muted">Scores appear as calls finish.</p>}
            <ol className="demo-rank">
              {shortlist.map(c => (
                <li key={c.id}>
                  <div className="row small"><strong className="grow">{c.name}</strong><span className="mono">Fit {c.fit} · ATS {c.ats}</span></div>
                  <p className="tiny muted" style={{ margin: '2px 0 0' }}>{c.summary}</p>
                </li>
              ))}
            </ol>
          </section>
        </div>

        {!embed && (
          <div className="row-wrap mt-lg" style={{ justifyContent: 'center', gap: 10 }}>
            <Link to="/login?as=hr" className="btn btn-primary btn-lg">Run your own campaign</Link>
            <Link to="/" className="btn btn-lg">How HireLens works</Link>
          </div>
        )}
      </div>
    </div>
  );
};
