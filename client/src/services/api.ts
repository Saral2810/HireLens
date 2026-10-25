import { AnswerType, Batch, BatchDetail, HrQuestion, InviteLinkResult, User } from '../types';

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

  // ── Temporary call-loop spike (roadmap Phase B) ──
  async spikeSpeak(text: string): Promise<{ audio: Blob; ms: number }> {
    const response = await fetch('/api/spike/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.authToken}` },
      body: JSON.stringify({ text })
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.message || `Speak failed (${response.status})`);
    }
    return { audio: await response.blob(), ms: Number(response.headers.get('X-Timbre-Ms') || 0) };
  }

  async spikeTurn(form: FormData): Promise<SpikeTurnResult> {
    return this.request<SpikeTurnResult>('/api/spike/turn', { method: 'POST', body: form });
  }
}

export interface SpikeTurnResult {
  transcript: string;
  decision: { action: 'next' | 'repeat' | 'skip'; extracted: Record<string, unknown> | null; source: 'llm' | 'rule' };
  say_text: string;
  audio_base64: string;
  audio_type: string;
  timings: { stt_ms: number; brain_ms: number; tts_ms: number; total_ms: number };
}

export const api = new ApiService();
