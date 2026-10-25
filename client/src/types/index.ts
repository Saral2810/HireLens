export type Role = 'superadmin' | 'candidate';

export type CandidateStatus = 'invited' | 'resume_uploaded' | 'in_call' | 'completed' | 'failed';

export interface BatchSummary {
  id: string;
  name: string;
  batch_date: string;
  job_role: string;
  company_name: string | null;
}

export type AnswerType = 'text' | 'number' | 'yes_no' | 'ctc' | 'duration';

export type StatusCounts = Record<CandidateStatus, number> & { total: number };

export interface Batch extends BatchSummary {
  job_description: string | null;
  created_at: string;
  updated_at: string;
  counts?: StatusCounts;
}

export interface HrQuestion {
  id: string;
  batch_id: string;
  question_text: string;
  position: number;
  answer_type: AnswerType;
}

export interface CandidateRow {
  id: string;
  batch_id: string;
  user_id: string | null;
  name: string;
  email: string;
  status: CandidateStatus;
  failure_reason?: string | null;
  created_at: string;
}

export interface BatchDetail extends Batch {
  questions: HrQuestion[];
  candidates: CandidateRow[];
}

export interface InviteLinkResult {
  candidate_id: string;
  name: string;
  email: string;
  invite_link?: string;
  error?: string;
}

export interface User {
  id: string;
  email: string;
  role: Role;
  name?: string | null;
  /** Only for candidates: their candidate record and batch. */
  candidate?: {
    id: string;
    name: string;
    status: CandidateStatus;
    batch: BatchSummary | null;
  } | null;
}
