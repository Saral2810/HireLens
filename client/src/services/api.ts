import { AnswerType, Batch, BatchDetail, BatchResults, CallDetail, CallEndReason, CallStartResult, CallTurnResult, CandidatePortal, HrQuestion, InviteLinkResult, ResumeUploadResult, User } from '../types';

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
      throw new Error(body.message || body.error || `Request failed (${response.status})`);
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

  async createBatch(fields: { name: string; job_role: string; batch_date?: string; company_name?: string; job_description?: string }): Promise<Batch> {
    return this.request('/api/hr/batches', { method: 'POST', body: JSON.stringify(fields) });
  }

  async updateBatch(batchId: string, fields: Partial<Pick<Batch, 'name' | 'job_role' | 'batch_date' | 'company_name' | 'job_description'>>): Promise<Batch> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}`, { method: 'PATCH', body: JSON.stringify(fields) });
  }

  async deleteBatch(batchId: string): Promise<void> {
    await this.request(`/api/hr/batches/${encodeURIComponent(batchId)}`, { method: 'DELETE' });
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

  async addCandidates(batchId: string, candidates: { name: string; email: string }[]): Promise<{ added: number; skipped_existing: number }> {
    return this.request(`/api/hr/batches/${encodeURIComponent(batchId)}/candidates`, { method: 'POST', body: JSON.stringify({ candidates }) });
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
  async startCall(): Promise<CallStartResult> {
    return this.request('/api/candidate/call/start', { method: 'POST' });
  }

  async callTurn(answer: Blob | null): Promise<CallTurnResult> {
    const form = new FormData();
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
