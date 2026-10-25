import React from 'react';
import { CandidateStatus } from '../../types';

export const STATUS_LABELS: Record<CandidateStatus, string> = {
  invited: 'Invited',
  resume_uploaded: 'Ready for call',
  in_call: 'In call',
  completed: 'Completed',
  failed: 'Did not finish'
};

const STATUS_TONES: Record<CandidateStatus, string> = {
  invited: 'grey',
  resume_uploaded: 'blue',
  in_call: 'amber',
  completed: 'green',
  failed: 'red'
};

export const StatusBadge: React.FC<{ status: CandidateStatus }> = ({ status }) => (
  <span className={`badge badge-${STATUS_TONES[status]}`}>{STATUS_LABELS[status]}</span>
);

/** Fit score as a coloured pill (green ≥ 70, amber ≥ 40, red below). */
export const ScorePill: React.FC<{ score: number | null | undefined }> = ({ score }) => {
  if (score === null || score === undefined) return <span className="score score-none">—</span>;
  const tone = score >= 70 ? 'high' : score >= 40 ? 'mid' : 'low';
  return <span className={`score score-${tone}`} title="Fit score (0–100)">{score}</span>;
};
