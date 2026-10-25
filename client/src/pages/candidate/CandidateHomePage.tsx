import React from 'react';
import { useAppStore } from '../../store/useAppStore';
import { CandidateStatus } from '../../types';

const STATUS_TEXT: Record<CandidateStatus, string> = {
  invited: 'Next step: upload your resume.',
  resume_uploaded: 'Resume received. Next step: the screening call.',
  in_call: 'Your screening call is in progress.',
  completed: 'Your screening call is complete. Thank you!',
  failed: 'Your screening call did not finish. Please contact HR.'
};

// Candidate portal home. Resume upload and mic check arrive in Phase F, the call in Phase G.
export const CandidateHomePage: React.FC = () => {
  const { currentUser } = useAppStore();
  const candidate = currentUser?.candidate;

  if (!candidate) {
    return (
      <div>
        <h2 style={{ marginTop: 0 }}>Welcome</h2>
        <p style={{ color: 'var(--lx-muted)' }}>We could not find a screening invitation for {currentUser?.email}. Please contact HR.</p>
      </div>
    );
  }

  const batch = candidate.batch;
  return (
    <div style={{ maxWidth: 640 }}>
      <h2 style={{ marginTop: 0 }}>Hi {candidate.name},</h2>
      <p style={{ fontSize: 15, lineHeight: 1.6 }}>
        You have been invited to a short voice screening for the role of <strong>{batch?.job_role}</strong>
        {batch?.company_name ? <> at <strong>{batch.company_name}</strong></> : null}.
      </p>
      <p style={{ color: 'var(--lx-muted)' }}>{STATUS_TEXT[candidate.status]}</p>
      <p style={{ color: 'var(--lx-muted)', fontSize: 13 }}>Batch: {batch?.name}</p>
    </div>
  );
};
