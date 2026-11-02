import React from 'react';
import { AtsBreakdown, FitBreakdown } from '../../types';

/** One labelled bar: points out of max, with a line of explanation under it. */
const Part: React.FC<{ label: string; points: number | null; max: number; note?: string | null; extra?: string }> = ({ label, points, max, note, extra }) => (
  <div className="score-part">
    <div className="row small">
      <span className="grow">{label}</span>
      <span className="mono">{points === null ? '—' : `${Math.round(points * 10) / 10}`}<span className="muted"> / {max}</span>{extra && <span className="muted"> · {extra}</span>}</span>
    </div>
    <div className="progress" aria-hidden="true"><div style={{ width: `${points === null ? 0 : Math.max(0, Math.min(100, (points / max) * 100))}%` }} /></div>
    {note && <div className="tiny muted mt-sm">{note}</div>}
  </div>
);

/** The fit score rubric: four rated parts with the reason for each, and the share of questions answered. */
export const FitScoreBreakdown: React.FC<{ breakdown: FitBreakdown | null | undefined; score: number | null | undefined }> = ({ breakdown, score }) => {
  if (!breakdown) {
    return <p className="small muted">{typeof score === 'number' ? 'This call was scored before the rubric was added, so there is no breakdown.' : 'No fit score yet.'}</p>;
  }
  const c = breakdown.completeness;
  return (
    <div className="stack-sm">
      {breakdown.criteria.map(k => (
        <Part key={k.key} label={k.label} points={k.points} max={k.weight} note={k.reason} extra={k.score === null ? 'not rated' : `${k.score}/10`} />
      ))}
      <Part label={c.label} points={c.points} max={c.weight} note={`${c.answered} of ${c.counted} questions answered${c.counted ? '' : ' (none counted)'}.`} />
      {breakdown.steering_capped && (
        <p className="tiny" role="note"><strong>Capped at 40:</strong> an answer tried to tell the reviewer what score to give.</p>
      )}
    </div>
  );
};

/** The resume's ATS checks with a tip each, and the job keywords found and missing. */
export const AtsScoreBreakdown: React.FC<{ breakdown: AtsBreakdown | null | undefined }> = ({ breakdown }) => {
  if (!breakdown) return <p className="small muted">No ATS score yet: it is worked out when the candidate uploads a resume.</p>;
  return (
    <div className="stack-sm">
      {breakdown.checks.map(k => <Part key={k.key} label={k.label} points={k.points} max={k.max} note={k.tip} />)}
      {breakdown.readable && (breakdown.matched.length > 0 || breakdown.missing.length > 0) && (
        <div className="small">
          <div className="tiny muted mb-sm">Job keywords</div>
          <div className="row-wrap" style={{ gap: 6 }}>
            {breakdown.matched.map(w => <span key={`m-${w}`} className="tag" title="Found in the resume">✓ {w}</span>)}
            {breakdown.missing.map(w => <span key={`x-${w}`} className="tag tag-missing" title="Not in the resume">{w}</span>)}
          </div>
        </div>
      )}
    </div>
  );
};

/** Plain-language explanation of both scores, for HR. */
export const ScoreHelp: React.FC = () => (
  <details className="small muted">
    <summary style={{ cursor: 'pointer' }}>How these scores are worked out</summary>
    <p className="mt-sm" style={{ lineHeight: 1.6 }}>
      <strong>Fit score (out of 100)</strong> rates the call answers against the role. The language model rates four parts from 0 to 10,
      each with a reason taken from what the candidate said: skills for the role (30), depth on their own projects (25),
      problem solving (15) and clear, complete answers (15). The share of questions answered adds up to 15. Accent, language and
      personal details are never rated, and an answer that tries to dictate its own score caps the total at 40.
    </p>
    <p style={{ lineHeight: 1.6 }}>
      <strong>ATS score (out of 100)</strong> checks the resume itself, the way an applicant tracking system would: keywords from the
      job role and description (40), standard sections (20), measurable results (15), action words (10) and length (15).
      It is calculated by fixed rules, so the same resume always gets the same score.
    </p>
  </details>
);
