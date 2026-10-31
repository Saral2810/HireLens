import { Analytics, AnswerType, Batch, BatchDetail, BatchResults, CallDetail, CallEndReason, CallLanguage, StaffMember, CallStartResult, CallTurnResult, CandidatePortal, CandidateRow, EmailQueueResult, HrQuestion, InviteLinkResult, ResumeUploadResult, User } from '../types';

const TOKEN_KEY = 'hr_auth_token';

class ApiService {
  private authToken: string | null = localStorage.getItem(TOKEN_KEY);

  public setAuthToken(token: string | null) {
    this.authToken = token;
    if (token) {
      localStorage.setItem(TOKEN_KEY, token);
    } else {
      localStorage.removeItem(TOKEN_KEY);
    }
  }

  public hasToken(): boolean {
    return !!this.authToken;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers || {});
    if (this.authToken) {
      headers.set('Authorization', `Bearer ${this.authToken}`);
    }
    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(endpoint, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      if (response.status === 401) {
        window.dispatchEvent(new Event('hr:unauthorized'));
      }
      // status and body travel with the error, e.g. so the call screen can wait when all lines are busy (429).
      throw Object.assign(new Error(body.message || body.error || `Request failed (${response.status})`), { status: response.status, body });
    }
    return body as T;
  }

  async login(email: string, password: string): Promise<{ success: boolean; token: string; user: User }> {
    const res = await this.request<{ success: boolean; token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (res.token) this.setAuthToken(res.token);
    return res;
  }

  async getMe(): Promise<User> {
    return this.request<User>('/api/auth/me');
  }

  // ── Candidate sign-in (Google or email code) ──
  /** Whether Google's sign-in button is set up, and its client ID. */
  async googleSignIn(): Promise<{ enabled: boolean; client_id: string | null }> {
    return this.request('/api/auth/google');
  }

  /** The ID token from Google's button → signed in (the server checks it with Supabase). */
  async googleToken(credential: string, nonce: string): Promise<{ token: string; user: User }> {
    const res = await this.request<{ token: string; user: User }>('/api/auth/google/token', { method: 'POST', body: JSON.stringify({ credential, nonce }) });
    if (res.token) this.setAuthToken(res.token);
    return res;
  }

  /** Personal link from the invite email → signed in as that candidate (the server makes the session). */
  async joinScreening(token: string): Promise<{ token: string; user: User }> {
    const res = await this.request<{ token: string; user: User }>('/api/auth/join', { method: 'POST', body: JSON.stringify({ token }) });
    if (res.token) this.setAuthToken(res.token);
    return res;
  }

  async sendEmailCode(email: string): Promise<{ sent: boolean; message: string }> {
    return this.request('/api/auth/email-code', { method: 'POST', body: JSON.stringify({ email }) });
  }

  async verifyEmailCode(email: string, code: string): Promise<{ token: string; user: User }> {
    const res = await this.request<{ token: string; user: User }>('/api/auth/email-code/verify', { method: 'POST', body: JSON.stringify({ email, code }) });
    if (res.token) this.setAuthToken(res.token);
    return res;
  }


  // ── HR dashboard, campaigns, team ──
  async analytics(): Promise<Analytics> {
    return this.request('/api/hr/analytics');
  }

  async runCampaign(batchId: string): Promise<Batch & { emails: EmailQueueResult }> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/run`, { method: 'POST' });
  }

  async closeCampaign(batchId: string): Promise<Batch> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/close`, { method: 'POST' });
  }

  /** Draft: starts (and emails invites) at start_at; close_at closes it later. Live: only close_at. ISO times. */
  async scheduleCampaign(batchId: string, times: { start_at?: string | null; close_at?: string | null }): Promise<Batch> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/schedule`, { method: 'POST', body: JSON.stringify(times) });
  }

  async unscheduleCampaign(batchId: string): Promise<Batch> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/schedule`, { method: 'DELETE' });
  }

  /** Reads name + email rows from an .xlsx or .csv file (nothing is saved). */
  async parseCandidatesFile(file: File): Promise<{ rows: { name: string; email: string }[]; header: boolean }> {
    const form = new FormData();
    form.append('file', file, file.name);
    return this.request('/api/hr/parse-candidates', { method: 'POST', body: form });
  }

  async team(): Promise<StaffMember[]> {
    return this.request('/api/hr/team');
  }

  async addTeamMember(fields: { name: string; email: string; password: string; role: 'superadmin' | 'recruiter' }): Promise<StaffMember> {
    return this.request('/api/hr/team', { method: 'POST', body: JSON.stringify(fields) });
  }

  async setTeamRole(userId: string, role: 'superadmin' | 'recruiter'): Promise<StaffMember> {
    return this.request(`/api/hr/team/${encodeURIComponent(userId)}`, { method: 'PATCH', body: JSON.stringify({ role }) });
  }

  async removeTeamMember(userId: string): Promise<void> {
    await this.request(`/api/hr/team/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }

  // ── Candidate ──
  async candidateMe(): Promise<CandidatePortal> {
    return this.request('/api/candidate/me');
  }

  async uploadResume(file: File): Promise<ResumeUploadResult> {
    const form = new FormData();
    form.append('resume', file, file.name);
    return this.request('/api/candidate/resume', { method: 'POST', body: form });
  }

  async giveConsent(): Promise<{ consent_given: boolean; consent_at: string }> {
    return this.request('/api/candidate/consent', { method: 'POST', body: JSON.stringify({ agree: true }) });
  }

  // ── HR ──
  async createInviteLink(candidateId: string): Promise<{ candidate_id: string; email: string; invite_link: string; note: string }> {
    return this.request(`/api/hr/candidates/${encodeURIComponent(candidateId)}/invite-link`, { method: 'POST' });
  }

  async sendInviteEmail(candidateId: string): Promise<{ candidate_id: string; sent: boolean }> {
    return this.request(`/api/hr/candidates/${encodeURIComponent(candidateId)}/send-invite`, { method: 'POST' });
  }

  async createInviteLinks(batchId: string, candidateIds?: string[]): Promise<{ links: InviteLinkResult[]; note: string }> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/invite-links`, {
      method: 'POST', body: JSON.stringify(candidateIds ? { candidate_ids: candidateIds } : {})
    });
  }

  async listBatches(): Promise<Batch[]> {
    return this.request('/api/hr/batches');
  }

  async getBatch(batchId: string): Promise<BatchDetail> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}`);
  }

  async createBatch(fields: { name: string; job_role: string; batch_date?: string; company_name?: string; company_intro?: string; job_description?: string; call_languages?: CallLanguage[] }): Promise<Batch> {
    return this.request('/api/hr/batches', { method: 'POST', body: JSON.stringify(fields) });
  }

  async updateBatch(batchId: string, fields: Partial<Pick<Batch, 'name' | 'job_role' | 'batch_date' | 'company_name' | 'company_intro' | 'job_description' | 'call_languages'>>): Promise<Batch> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}`, { method: 'PATCH', body: JSON.stringify(fields) });
  }

  /** confirmName: the campaign's name, required once candidates have started. */
  async deleteBatch(batchId: string, confirmName?: string): Promise<{ deleted: boolean; candidates: number; files_removed: number }> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}`, {
      method: 'DELETE', body: JSON.stringify(confirmName !== undefined ? { confirm_name: confirmName } : {})
    });
  }

  async addQuestion(batchId: string, fields: { question_text: string; answer_type: AnswerType }): Promise<HrQuestion> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/questions`, { method: 'POST', body: JSON.stringify(fields) });
  }

  async addDefaultQuestions(batchId: string): Promise<{ added: number; questions: HrQuestion[] }> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/questions/defaults`, { method: 'POST' });
  }

  async updateQuestion(questionId: string, fields: Partial<Pick<HrQuestion, 'question_text' | 'answer_type'>>): Promise<HrQuestion> {
    return this.request(`/api/hr/questions/${encodeURIComponent(questionId)}`, { method: 'PATCH', body: JSON.stringify(fields) });
  }

  async deleteQuestion(questionId: string): Promise<void> {
    await this.request(`/api/hr/questions/${encodeURIComponent(questionId)}`, { method: 'DELETE' });
  }

  async reorderQuestions(batchId: string, ids: string[]): Promise<HrQuestion[]> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/questions/order`, { method: 'PUT', body: JSON.stringify({ ids }) });
  }

  async addCandidates(batchId: string, candidates: { name: string; email: string }[]): Promise<{ added: number; skipped_existing: number; emails?: EmailQueueResult }> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/candidates`, { method: 'POST', body: JSON.stringify({ candidates }) });
  }

  async updateCandidate(candidateId: string, fields: { name?: string; email?: string }): Promise<CandidateRow & { emails: EmailQueueResult }> {
    return this.request(`/api/hr/candidates/${encodeURIComponent(candidateId)}`, { method: 'PATCH', body: JSON.stringify(fields) });
  }

  async deleteCandidate(candidateId: string): Promise<void> {
    await this.request(`/api/hr/candidates/${encodeURIComponent(candidateId)}`, { method: 'DELETE' });
  }

  async allowRetake(candidateId: string): Promise<{ candidate_id: string; status: string; note: string }> {
    return this.request(`/api/hr/candidates/${encodeURIComponent(candidateId)}/allow-retake`, { method: 'POST' });
  }

  // ── Results (Phase H) ──
  async getResults(batchId: string): Promise<BatchResults> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/results`);
  }

  async getCall(callId: string): Promise<CallDetail> {
    return this.request(`/api/hr/calls/${encodeURIComponent(callId)}`);
  }

  /** Downloads the results table as a file (the browser saves it). */
  async downloadResults(batchId: string, format: 'csv' | 'xlsx'): Promise<void> {
    const response = await fetch(`/api/hr/batches/${encodeURIComponent(batchId)}/export?format=${format}`, {
      headers: this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      if (response.status === 401) window.dispatchEvent(new Event('hr:unauthorized'));
      throw new Error(body.message || `Export failed (${response.status})`);
    }
    const name = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || `results.${format}`;
    const url = URL.createObjectURL(await response.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Screening call (Phase G) ──
  async startCall(language: CallLanguage = 'mixed'): Promise<CallStartResult> {
    return this.request('/api/candidate/call/start', { method: 'POST', body: JSON.stringify({ language }) });
  }

  /** turnId: the same id when this answer is sent again, so the server processes it only once. */
  async callTurn(answer: Blob | null, turnId: string): Promise<CallTurnResult> {
    const form = new FormData();
    form.append('turn_id', turnId);
    if (answer) form.append('audio', answer, 'answer.wav');
    else form.append('no_speech', '1');
    return this.request('/api/candidate/call/turn', { method: 'POST', body: form });
  }

  async uploadRecording(recording: Blob): Promise<{ recording_path: string }> {
    const form = new FormData();
    const ext = recording.type.includes('ogg') ? 'ogg' : 'webm';
    form.append('recording', recording, `call.${ext}`);
    return this.request('/api/candidate/call/recording', { method: 'POST', body: form });
  }

  /** After a call that stopped part-way: lets the candidate start again (limited number of tries). */
  async retryCall(): Promise<{ status: string; retries_left: number }> {
    return this.request('/api/candidate/call/retry', { method: 'POST' });
  }

  /** Ends the call early. keepalive lets it finish while the page is closing. */
  endCall(reason: CallEndReason): Promise<unknown> {
    return fetch('/api/candidate/call/end', {
      method: 'POST',
      keepalive: true,
      headers: { 'Content-Type': 'application/json', ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}) },
      body: JSON.stringify({ reason })
    }).catch(() => undefined);
  }
}

export const api = new ApiService();
