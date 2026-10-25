import { User } from '../types';

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
