import React from 'react';
import { CandidateStatus } from '../../types';

export const STATUS_LABELS: Record<CandidateStatus, string> = {
  invited: 'Invited',
  resume_uploaded: 'Resume uploaded',
  in_call: 'In call',
  completed: 'Completed',
  failed: 'Failed'
};

const STATUS_COLORS: Record<CandidateStatus, string> = {
  invited: '#94a3b8',
  resume_uploaded: '#60a5fa',
  in_call: '#f59e0b',
  completed: '#22c55e',
  failed: '#ef4444'
};

export const StatusBadge: React.FC<{ status: CandidateStatus }> = ({ status }) => (
  <span style={{
    display: 'inline-block', padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600,
    color: STATUS_COLORS[status], border: `1px solid ${STATUS_COLORS[status]}55`, background: `${STATUS_COLORS[status]}1a`
  }}>
    {STATUS_LABELS[status]}
  </span>
);
