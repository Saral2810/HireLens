import React from 'react';
import { CampaignStatus, CandidateStatus } from '../../types';

export const STATUS_LABELS: Record<CandidateStatus, string> = {
  invited: 'Added',
  resume_uploaded: 'Ready for call',
  in_call: 'In call',
  completed: 'Completed',
  failed: 'Did not finish'
};

// Black and white only: fill, outline weight and dashes tell statuses apart.
const STATUS_STYLE: Record<CandidateStatus, string> = {
  invited: 'badge-faint',
  resume_uploaded: 'badge-strong',
  in_call: 'badge-strong badge-live',
  completed: 'badge-solid',
  failed: 'badge-dashed'
};

export const StatusBadge: React.FC<{ status: CandidateStatus }> = ({ status }) => (
  <span className={`badge ${STATUS_STYLE[status]}`}>{STATUS_LABELS[status]}</span>
);

export const CAMPAIGN_LABELS: Record<CampaignStatus, string> = { draft: 'Draft', live: 'Live', closed: 'Closed' };

/** scheduled: a draft with a start time ("Scheduled" instead of "Draft"). */
export const CampaignBadge: React.FC<{ status: CampaignStatus; scheduled?: boolean }> = ({ status, scheduled }) => (
  <span className={`badge ${status === 'live' ? 'badge-solid badge-live' : status === 'closed' ? 'badge-dashed' : 'badge-faint'}`}>
    {status === 'draft' && scheduled ? 'Scheduled' : CAMPAIGN_LABELS[status]}
  </span>
);

/** Fit score: filled ≥ 70, outlined ≥ 40, dashed below. */
export const ScorePill: React.FC<{ score: number | null | undefined }> = ({ score }) => {
  if (score === null || score === undefined) return <span className="score score-none">—</span>;
  const tone = score >= 70 ? 'high' : score >= 40 ? 'mid' : 'low';
  return <span className={`score score-${tone}`} title="Fit score (0–100)">{score}</span>;
};
