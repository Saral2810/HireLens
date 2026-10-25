/** superadmin is shown as Admin. Admin and Recruiter are the HR team. */
export type Role = 'superadmin' | 'recruiter' | 'candidate';
export const isHrRole = (role?: Role | null) => role === 'superadmin' || role === 'recruiter';

export type CampaignStatus = 'draft' | 'live' | 'closed';

export type CandidateStatus = 'invited' | 'resume_uploaded' | 'in_call' | 'completed' | 'failed';

export interface BatchSummary {
  id: string;
  name: string;
  batch_date: string;
  job_role: string;
  company_name: string | null;
  status?: CampaignStatus;
}

export type AnswerType = 'text' | 'number' | 'yes_no' | 'ctc' | 'duration';

export type StatusCounts = Record<CandidateStatus, number> & { total: number };

export interface Batch extends BatchSummary {
  job_description: string | null;
  created_by?: string | null;
  launched_at?: string | null;
  closed_at?: string | null;
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

/** What a candidate sees about their own screening (questions stay hidden until the call). */
export interface CandidatePortal {
  id: string;
  name: string;
  status: CandidateStatus;
  consent_given: boolean;
  has_resume: boolean;
  batch: BatchSummary | null;
  /** Why the last call stopped (only while status is "failed"). */
  failure_reason: string | null;
  /** How many more times the candidate may start the call themselves after it stopped. */
  retries_left: number;
}

export interface ResumeUploadResult {
  status: CandidateStatus;
  readable: boolean;
  pages: number;
  questions_ready: number;
  questions_from: 'resume' | 'general';
  message: string;
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

/** One thing the agent says, with its audio (base64). */
export interface CallLine {
  text: string;
  audio_base64: string;
  audio_type: string;
}

export interface CallStartResult {
  call_id: string;
  total_questions: number;
  position: number;
  lines: CallLine[];
  done: false;
}

export interface CallTurnResult {
  position: number;
  lines: CallLine[];
  done: boolean;
  outcome?: 'completed' | 'not_ready';
  heard: string;
  decision: 'next' | 'repeat' | 'skip';
  timings: { stt_ms: number; brain_ms: number; tts_ms: number; total_ms: number };
}

export type CallEndReason = 'ended_by_candidate' | 'left_page' | 'client_error';

// ── Results (Phase H) ──

export interface ResultAnswer {
  position: number;
  source: 'intro' | 'resume' | 'hr';
  question_text: string;
  answer_type: AnswerType;
  outcome: 'answered' | 'skipped';
  attempts: number;
  answer_text: string | null;
  extracted_value: Record<string, unknown> | null;
  /** Ready to show: "60 days", "12 LPA", "Yes", "Skipped", or the answer text. */
  display: string;
}

export interface ResultCall {
  id: string;
  status: 'in_progress' | 'completed' | 'failed';
  started_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  summary: string | null;
  fit_score: number | null;
  has_recording: boolean;
  failure_reason: string | null;
}

export interface ResultRow {
  candidate_id: string;
  name: string;
  email: string;
  status: CandidateStatus;
  failure_reason: string | null;
  /** How many calls the candidate has had (a retake makes it more than 1). */
  attempts: number;
  call: ResultCall | null;
  notice_period_days: number | null;
  current_ctc_lpa: number | null;
  expected_ctc_lpa: number | null;
  answers: ResultAnswer[];
}

export interface BatchResults {
  batch: Batch;
  questions: HrQuestion[];
  rows: ResultRow[];
}

export interface TranscriptLine {
  speaker: 'agent' | 'candidate';
  text: string;
  position: number | null;
  at: string;
}

export interface CallDetail extends ResultRow {
  transcript: TranscriptLine[];
  recording_url: string | null;
  resume_url: string | null;
  links_expire_in_seconds: number;
}


// ── Dashboard and team (UI rebuild) ──

export interface AnalyticsCall {
  call_id: string;
  candidate_id: string;
  name: string;
  campaign: string;
  campaign_id: string | null;
  status: 'in_progress' | 'completed' | 'failed';
  fit_score: number | null;
  ended_at: string | null;
}

export interface Analytics {
  campaigns: { total: number; draft: number; live: number; closed: number };
  candidates: { total: number; by_status: Record<CandidateStatus, number> };
  calls: { completed: number; failed: number; in_progress: number };
  completion_rate: number | null;
  avg_fit_score: number | null;
  avg_call_seconds: number | null;
  funnel: { stage: string; count: number }[];
  per_day: { day: string; completed: number; failed: number }[];
  score_distribution: { label: string; count: number }[];
  top_candidates: AnalyticsCall[];
  recent_calls: AnalyticsCall[];
}

export interface StaffMember {
  id: string;
  name: string | null;
  email: string;
  role: 'superadmin' | 'recruiter';
  created_at: string;
  campaigns: number;
  is_you?: boolean;
}

export interface Screening {
  id: string;
  status: CandidateStatus;
  created_at: string;
  batch: { id: string; name: string; job_role: string; company_name: string | null; status: CampaignStatus };
}
