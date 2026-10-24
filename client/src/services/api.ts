import { 
  Campaign, 
  DashboardStats, 
  DncRecord, 
  FunnelStage, 
  Lead, 
  ScheduledJob, 
  Tenant, 
  TenantUser, 
  User, 
  VoiceAgent, 
  VoiceProvider 
} from '../types';

class ApiService {
  private activeTenant: string = localStorage.getItem('lx_active_tenant') || 'demo';
  private authToken: string | null = localStorage.getItem('lx_auth_token') || null;

  public setTenant(tenantId: string) {
    this.activeTenant = tenantId;
    localStorage.setItem('lx_active_tenant', tenantId);
  }

  public getTenant(): string {
    return this.activeTenant;
  }

  public setAuthToken(token: string | null) {
    this.authToken = token;
    if (token) {
      localStorage.setItem('lx_auth_token', token);
    } else {
      localStorage.removeItem('lx_auth_token');
    }
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const headers = new Headers(options.headers || {});
    
    if (this.activeTenant) {
      headers.set('x-tenant-id', this.activeTenant);
    }

    if (this.authToken) {
      headers.set('Authorization', `Bearer ${this.authToken}`);
    } else {
      const mockToken = localStorage.getItem('lx_mock_token') || 'superadmin';
      const clean = mockToken.replace(/^(mock[-_])+/i, '').trim();
      if (clean) {
        headers.set('Authorization', `Bearer mock-${clean}`);
      }
    }

    if (!headers.has('Content-Type') && !(options.body instanceof FormData)) {
      headers.set('Content-Type', 'application/json');
    }

    const response = await fetch(endpoint, {
      ...options,
      headers
    });

    if (response.status === 401) {
      this.setAuthToken(null);
      // Dispatch custom event for session expiry
      window.dispatchEvent(new CustomEvent('lx:unauthorized'));
    }

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const errorMsg = data?.error || data?.message || `Request failed with status ${response.status}`;
      throw new Error(errorMsg);
    }

    return data as T;
  }

  // --- Auth & Profile ---
  async getMe(): Promise<User> {
    return this.request<User>('/api/auth/me');
  }

  async login(email: string, password: string): Promise<{ success: boolean; token: string; user: User }> {
    const res = await this.request<{ success: boolean; token: string; user: User }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password })
    });
    if (res.token) {
      this.setAuthToken(res.token);
    }
    return res;
  }

  // --- Dashboard & Analytics ---
  async getDashboardStats(campaignId: string = 'all', dateRange: string = '7d'): Promise<DashboardStats> {
    const params = new URLSearchParams({ date_range: dateRange });
    if (campaignId && campaignId !== 'all') params.set('campaign_id', campaignId);
    try {
      // Backend: GET /leads/analytics/summary
      const d = await this.request<any>(`/leads/analytics/summary?${params}`);
      const k = d?.kpis || {};
      const f = d?.funnel || {};
      return {
        total_leads: k.total_leads || 0,
        connected_leads: k.connected || 0,
        qualified_leads: f.qualified || 0,
        escalated_leads: (d?.attention?.escalations || []).length,
        contact_rate: k.connect_rate || 0,
        qualification_rate: f.connected ? Math.round(((f.qualified || 0) / f.connected) * 1000) / 10 : 0,
        avg_duration: 0
      } as DashboardStats;
    } catch {
      return {
        total_leads: 0,
        connected_leads: 0,
        qualified_leads: 0,
        escalated_leads: 0,
        contact_rate: 0,
        qualification_rate: 0,
        avg_duration: 0
      };
    }
  }

  async getFunnelAnalytics(campaignId: string = 'all', dateRange: string = '7d'): Promise<FunnelStage[]> {
    const params = new URLSearchParams({ date_range: dateRange });
    if (campaignId && campaignId !== 'all') params.set('campaign_id', campaignId);
    try {
      const d = await this.request<any>(`/leads/analytics/summary?${params}`);
      const f = d?.funnel || {};
      const base = f.leads || 0;
      const pct = (n: number) => (base ? Math.round((n / base) * 1000) / 10 : 0);
      return [
        { stage: 'Ingested', count: base, percent: base ? 100 : 0 },
        { stage: 'Dialed', count: f.attempted || 0, percent: pct(f.attempted || 0) },
        { stage: 'Connected', count: f.connected || 0, percent: pct(f.connected || 0) },
        { stage: 'Qualified', count: f.qualified || 0, percent: pct(f.qualified || 0) }
      ] as FunnelStage[];
    } catch {
      return [];
    }
  }

  // --- Leads ---
  async getLeads(params: {
    limit?: number;
    offset?: number;
    status?: string;
    campaign_id?: string;
    search?: string;
  } = {}): Promise<{ leads: Lead[]; total: number }> {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.offset) query.set('offset', String(params.offset));
    if (params.status && params.status !== 'all') query.set('status', params.status);
    if (params.campaign_id && params.campaign_id !== 'all') query.set('campaign_id', params.campaign_id);
    if (params.search) query.set('search', params.search);

    try {
      const res = await this.request<any>(`/leads?${query}`);
      const list = Array.isArray(res) ? res : res.leads || res.data || [];
      return {
        leads: list,
        total: res.total || list.length
      };
    } catch (e) {
      console.warn('Fallback leads on error:', e);
      return { leads: [], total: 0 };
    }
  }

  async getLeadDetails(leadId: string): Promise<Lead> {
    return this.request<Lead>(`/leads/${leadId}`);
  }

  // --- Campaigns ---
  async getCampaigns(): Promise<Campaign[]> {
    try {
      const res = await this.request<any>('/campaigns');
      return Array.isArray(res) ? res : res.campaigns || [];
    } catch {
      return [];
    }
  }

  async createCampaign(data: Partial<Campaign>): Promise<Campaign> {
    return this.request<Campaign>('/campaigns', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async updateCampaign(campaignId: string, updates: Partial<Campaign>): Promise<Campaign> {
    return this.request<Campaign>(`/campaigns/${campaignId}`, {
      method: 'PATCH',
      body: JSON.stringify(updates)
    });
  }

  async switchProvider(campaignId: string, payload: {
    new_provider_type: string;
    new_voice_agent_id: string;
    drain?: boolean;
  }): Promise<any> {
    const query = payload.drain ? '?drain=true' : '';
    return this.request(`/admin/campaigns/${campaignId}/switch-provider${query}`, {
      method: 'PATCH',
      body: JSON.stringify({
        new_provider_type: payload.new_provider_type,
        new_voice_agent_id: payload.new_voice_agent_id
      })
    });
  }

  async triggerCampaignDial(campaignId: string): Promise<any> {
    return this.request(`/campaigns/${campaignId}/dial`, {
      method: 'POST'
    });
  }

  // --- Voice Providers & Agents ---
  async getVoiceProviders(): Promise<VoiceProvider[]> {
    try {
      const res = await this.request<any>('/admin/voice-providers');
      return Array.isArray(res) ? res : res.providers || [];
    } catch {
      return [];
    }
  }

  async getAgents(): Promise<VoiceAgent[]> {
    try {
      const res = await this.request<any>('/admin/agents');
      return Array.isArray(res) ? res : res.agents || [];
    } catch {
      return [];
    }
  }

  async triggerTestCall(phone: string, agentId: string, provider: string): Promise<any> {
    return this.request('/admin/agents/test-call', {
      method: 'POST',
      body: JSON.stringify({ phone, agent_id: agentId, provider })
    });
  }

  // --- Live Monitor ---
  async getLiveCalls(): Promise<any[]> {
    try {
      const res = await this.request<any>('/leads/active-sessions');
      return Array.isArray(res) ? res : res.active_calls || [];
    } catch {
      return [];
    }
  }

  // --- Tenants & Workspaces (Super Admin) ---
  async getTenants(): Promise<Tenant[]> {
    try {
      const res = await this.request<any>('/tenants');
      const list = Array.isArray(res) ? res : (res.tenants || res.data || []);
      return list.map((t: any) => ({
        ...t,
        id: t.id || t.tenant_id,
        tenant_id: t.tenant_id || t.id,
        name: t.name || t.tenant_id || t.id
      }));
    } catch {
      return [];
    }
  }

  async createTenant(data: { id: string; name: string }): Promise<Tenant> {
    return this.request<Tenant>('/tenants', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  async getTenantUsers(tenantId: string): Promise<TenantUser[]> {
    try {
      const res = await this.request<any>(`/tenants/${tenantId}/users`);
      return Array.isArray(res) ? res : res.users || [];
    } catch {
      return [];
    }
  }

  async createTenantUser(tenantId: string, payload: { email: string; role: string; password?: string }): Promise<any> {
    return this.request(`/tenants/${tenantId}/users`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
  }

  async resetTenantUserPassword(tenantId: string, userId: string): Promise<{ success: boolean; new_password?: string; share_package?: string }> {
    return this.request(`/tenants/${tenantId}/users/${userId}/reset-password`, {
      method: 'POST'
    });
  }

  async deleteTenantUser(tenantId: string, userId: string): Promise<any> {
    return this.request(`/tenants/${tenantId}/users/${userId}`, {
      method: 'DELETE'
    });
  }

  // --- DNC Registry ---
  async getDncList(): Promise<DncRecord[]> {
    try {
      const res = await this.request<any>('/leads/dnc');
      return Array.isArray(res) ? res : res.dnc || [];
    } catch {
      return [];
    }
  }

  async addDncNumber(phone: string, reason: string): Promise<DncRecord> {
    return this.request<DncRecord>('/leads/dnc', {
      method: 'POST',
      body: JSON.stringify({ phone, reason })
    });
  }

  async deleteDncNumber(id: string): Promise<any> {
    return this.request(`/leads/dnc/${id}`, {
      method: 'DELETE'
    });
  }

  // --- Scheduler & Jobs ---
  async getScheduledJobs(): Promise<ScheduledJob[]> {
    try {
      const res = await this.request<any>('/scheduler/jobs');
      return Array.isArray(res) ? res : res.jobs || [];
    } catch {
      return [];
    }
  }

  async triggerJobNow(jobId: string): Promise<any> {
    return this.request(`/scheduler/jobs/${jobId}/trigger`, {
      method: 'POST'
    });
  }
}

export const api = new ApiService();
