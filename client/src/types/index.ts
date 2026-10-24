export type PageType = 
  | 'home' 
  | 'campaigns' 
  | 'leads' 
  | 'agents' 
  | 'crm' 
  | 'scheduler' 
  | 'integrations' 
  | 'settings' 
  | 'monitor' 
  | 'dnc' 
  | 'help';

export interface User {
  id: string;
  email: string;
  isSuperAdmin: boolean;
  allowedTenants?: string[];
  roles?: Record<string, string>;
}

export interface Tenant {
  id: string;
  name: string;
  created_at?: string;
  is_active?: boolean;
}

export interface TenantUser {
  id: string;
  email: string;
  role: 'admin' | 'member' | 'owner';
  tenant_id: string;
  plain_password?: string;
  created_at?: string;
}

export interface Lead {
  id: string;
  name: string;
  phone: string;
  status: 'QUALIFIED' | 'CALL_NEEDED' | 'ESCALATED' | 'DNC' | 'BUSY' | 'NO_ANSWER' | 'FAILED' | 'PENDING' | string;
  lead_score: number;
  attempts: number;
  last_call_at?: string;
  campaign_id?: string;
  campaign_name?: string;
  created_at?: string;
  telephony_status?: string;
  duration_seconds?: number;
  qualification_reasons?: string[];
  ai_summary?: string;
  sentiment?: 'positive' | 'neutral' | 'negative';
  recording_url?: string;
  transcript?: Array<{ speaker: 'agent' | 'user'; text: string; time?: string }>;
  metadata?: Record<string, any>;
  // HR candidate details
  job_role?: string;
  current_company?: string;
  experience_years?: number;
  current_ctc?: number;
  expected_ctc?: number;
  notice_period_days?: number;
  skills?: string;
  resume_url?: string;
  interview_slot?: string;
  screening_status?: ScreeningStatus;
  screening_answers?: Record<string, any>;
}

export type ScreeningStatus = 'pending' | 'shortlisted' | 'maybe' | 'rejected' | 'not_interested';

export interface Campaign {
  id: string;
  name: string;
  status: 'active' | 'paused' | 'completed' | 'draft';
  voice_provider: 'gnani' | 'mock' | string;
  voice_agent_id: string;
  concurrency_limit?: number;
  total_leads?: number;
  dialed_count?: number;
  qualified_count?: number;
  created_at?: string;
  tenant_id: string;
}

export interface VoiceProvider {
  id?: string;
  provider_type: 'gnani' | 'mock' | string;
  name?: string;
  is_active?: boolean;
  configured_at?: string;
  disabled_at?: string | null;
  masked_key?: string;
}

export interface VoiceAgent {
  id: string;
  name: string;
  provider_type: string;
  voice_id?: string;
  description?: string;
}

export interface CallSession {
  id: string;
  lead_id: string;
  campaign_id?: string;
  lead_name: string;
  phone: string;
  status: 'dialing' | 'connected' | 'analyzing' | 'ended';
  provider: string;
  duration_seconds: number;
  started_at: string;
  ended_at?: string | null;
  latency_ms?: number;
}

export interface ScheduledJob {
  id: string;
  name: string;
  schedule_cron: string;
  status: 'active' | 'paused' | 'running';
  next_run?: string;
  last_run?: string;
  campaign_name?: string;
}

export interface DncRecord {
  id: string;
  phone: string;
  reason?: string;
  created_at: string;
}

export interface DashboardStats {
  total_leads: number;
  connected_leads: number;
  qualified_leads: number;
  escalated_leads: number;
  contact_rate: number;
  qualification_rate: number;
  avg_duration: number;
}

export interface FunnelStage {
  stage: string;
  count: number;
  percent: number;
}

export interface NotificationItem {
  id: string;
  title: string;
  message: string;
  timestamp: string;
  type: 'info' | 'success' | 'warning' | 'error';
  read: boolean;
}
