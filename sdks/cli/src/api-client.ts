import type { ClawRentConfig } from './config.js';

export class ApiClient {
  private config: ClawRentConfig;
  /** When set (e.g. by ProviderAgent.start), overrides config.token for REST auth. */
  private agentTokenOverride: string | null = null;

  constructor(config: ClawRentConfig) {
    this.config = config;
  }

  /**
   * Set a token that overrides config.token for subsequent REST requests.
   * Used by the in-process provider agent: once serving with an agentToken,
   * provider REST calls (approve/list/end + internal autoApprove) authenticate
   * as the agent owner via this token, so they work without a separate user
   * JWT login. The backend's resolveAuth accepts the agt_clawrent_* prefix.
   * Pass null to clear (e.g. on stop_serving).
   */
  setAgentToken(token: string | null): void {
    this.agentTokenOverride = token;
  }

  get apiUrl(): string {
    return this.config.apiUrl;
  }

  get wsUrl(): string {
    return this.config.wsUrl;
  }

  get userId(): string | undefined {
    return this.config.userId;
  }

  // --- Auth (no auth needed) ---

  async sendVerification(email: string): Promise<{ message: string }> {
    return this.request('POST', '/api/auth/send-verification', { email }, false);
  }

  async registerUser(input: {
    email: string;
    password: string;
    name: string;
    verificationCode: string;
  }): Promise<{ user: { id: string; email: string; name: string; role: string }; token: string; apiKey: string }> {
    return this.request('POST', '/api/auth/register', input, false);
  }

  async login(email: string, password: string): Promise<{ user: { id: string; email: string; name: string; role: string }; token: string }> {
    return this.request('POST', '/api/auth/login', { email, password }, false);
  }

  async getMe(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/auth/me');
  }

  // --- Marketplace ---

  async browse(query?: { search?: string; category?: string; page?: number; limit?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (query?.search) params.set('search', query.search);
    if (query?.category) params.set('category', query.category);
    if (query?.page) params.set('page', String(query.page));
    if (query?.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return this.request('GET', `/api/marketplace/browse${qs ? `?${qs}` : ''}`);
  }

  async getAgent(slug: string): Promise<unknown> {
    return this.request('GET', `/api/marketplace/agents/${encodeURIComponent(slug)}`);
  }

  // --- Sessions ---

  async rent(options: { agentId: string; taskDescription: string; grantedPermissions?: Record<string, unknown> }): Promise<unknown> {
    return this.request('POST', '/api/sessions', {
      agentId: options.agentId,
      taskDescription: options.taskDescription,
      grantedPermissions: options.grantedPermissions ?? {},
    });
  }

  async getSessions(query?: { role?: string; status?: string; page?: number; limit?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (query?.role) params.set('role', query.role);
    if (query?.status) params.set('status', query.status);
    if (query?.page) params.set('page', String(query.page));
    if (query?.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return this.request('GET', `/api/sessions${qs ? `?${qs}` : ''}`);
  }

  async getSession(sessionId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async getSessionMessages(sessionId: string): Promise<unknown> {
    return this.request('GET', `/api/sessions/${encodeURIComponent(sessionId)}/messages`);
  }

  async endSession(sessionId: string): Promise<unknown> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/end`);
  }

  async approveSession(sessionId: string): Promise<unknown> {
    return this.request('POST', `/api/sessions/${encodeURIComponent(sessionId)}/approve`);
  }

  // --- Billing ---

  async getBalance(): Promise<{ balance: string }> {
    return this.request('GET', '/api/billing/wallet');
  }

  async topUp(amount: string): Promise<{ balance: string }> {
    return this.request('POST', '/api/billing/wallet/topup', { amount });
  }

  // --- Provider: Agents ---

  async registerAgent(data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', '/api/agents', data);
  }

  async getMyAgents(query?: { page?: number; limit?: number; roles?: string }): Promise<unknown> {
    const params = new URLSearchParams();
    if (query?.page) params.set('page', String(query.page));
    if (query?.limit) params.set('limit', String(query.limit));
    if (query?.roles) params.set('roles', query.roles);
    const qs = params.toString();
    return this.request('GET', `/api/agents/my${qs ? `?${qs}` : ''}`);
  }

  /** Resolve the current agent from agentToken. Requires agt_clawrent_ token auth. */
  async getMyAgent(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/agents/me/agent');
  }

  async applyProvider(agentId: string, data: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/api/agents/${encodeURIComponent(agentId)}/apply-provider`, data);
  }

  /** Publish agent — simplified apply-provider with defaults, submits for admin review */
  async publishAgent(agentId: string, data?: Record<string, unknown>): Promise<unknown> {
    return this.request('POST', `/api/agents/${encodeURIComponent(agentId)}/publish`, data ?? {});
  }

  /** Activate agent — verify admin-approved + WebSocket connected, then go online */
  async activateAgent(agentId: string): Promise<unknown> {
    return this.request('POST', `/api/agents/${encodeURIComponent(agentId)}/activate`);
  }

  async setOnlineStatus(agentId: string, onlineStatus: string): Promise<unknown> {
    return this.request('PATCH', `/api/agents/${encodeURIComponent(agentId)}/status`, { onlineStatus });
  }

  async generateAgentToken(agentId: string): Promise<{ agentId: string; token: string; createdAt: string; warning: string }> {
    return this.request('POST', `/api/agents/${encodeURIComponent(agentId)}/token`);
  }

  async revokeAgentToken(agentId: string): Promise<{ message: string }> {
    return this.request('DELETE', `/api/agents/${encodeURIComponent(agentId)}/token`);
  }

  // --- Orders ---

  async createOrder(data: {
    items: Array<{ providerAgentId: string; consumerAgentId?: string; taskDescription: string; grantedPermissions?: Record<string, unknown> }>;
    note?: string;
    fromCart?: boolean;
  }): Promise<unknown> {
    return this.request('POST', '/api/orders', data);
  }

  async getOrders(query?: { status?: string; page?: number; limit?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (query?.status) params.set('status', query.status);
    if (query?.page) params.set('page', String(query.page));
    if (query?.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return this.request('GET', `/api/orders${qs ? `?${qs}` : ''}`);
  }

  async getOrder(orderId: string): Promise<unknown> {
    return this.request('GET', `/api/orders/${encodeURIComponent(orderId)}`);
  }

  async cancelOrder(orderId: string): Promise<unknown> {
    return this.request('POST', `/api/orders/${encodeURIComponent(orderId)}/cancel`);
  }

  // --- Cart ---

  async getCart(): Promise<unknown> {
    return this.request('GET', '/api/cart');
  }

  async addToCart(data: { providerAgentId: string; taskDescription: string }): Promise<unknown> {
    return this.request('POST', '/api/cart', data);
  }

  async updateCartItem(itemId: string, data: { taskDescription: string }): Promise<unknown> {
    return this.request('PATCH', `/api/cart/${encodeURIComponent(itemId)}`, data);
  }

  async removeFromCart(itemId: string): Promise<unknown> {
    return this.request('DELETE', `/api/cart/${encodeURIComponent(itemId)}`);
  }

  async clearCart(): Promise<unknown> {
    return this.request('DELETE', '/api/cart');
  }

  // --- Favorites ---

  async listFavorites(query?: { page?: number; limit?: number }): Promise<unknown> {
    const params = new URLSearchParams();
    if (query?.page) params.set('page', String(query.page));
    if (query?.limit) params.set('limit', String(query.limit));
    const qs = params.toString();
    return this.request('GET', `/api/favorites${qs ? `?${qs}` : ''}`);
  }

  async addFavorite(agentId: string): Promise<unknown> {
    return this.request('POST', `/api/favorites/${encodeURIComponent(agentId)}`);
  }

  async removeFavorite(agentId: string): Promise<unknown> {
    return this.request('DELETE', `/api/favorites/${encodeURIComponent(agentId)}`);
  }

  // --- Health ---

  async health(): Promise<unknown> {
    return this.request('GET', '/api/health', undefined, false);
  }

  // --- Docs (MCP interface) ---

  async getDocsTree(): Promise<unknown> {
    return this.request('GET', '/api/mcp/docs/tree', undefined, false);
  }

  async getDocByPath(path: string): Promise<unknown> {
    return this.request('GET', `/api/mcp/docs/by-path/${encodeURI(path)}`, undefined, false);
  }

  async searchDocs(query: string): Promise<unknown> {
    const params = new URLSearchParams({ q: query });
    return this.request('GET', `/api/mcp/docs/search?${params.toString()}`, undefined, false);
  }

  async getDoc(id: string): Promise<unknown> {
    return this.request('GET', `/api/mcp/docs/${encodeURIComponent(id)}`, undefined, false);
  }

  async createDoc(data: { type: string; title: string; parentId?: string; content?: string; slug?: string; icon?: string }): Promise<unknown> {
    return this.request('POST', '/api/mcp/docs', data);
  }

  async updateDoc(id: string, data: { title?: string; content?: string; changeSummary?: string }): Promise<unknown> {
    return this.request('PATCH', `/api/mcp/docs/${encodeURIComponent(id)}`, data);
  }

  async deleteDoc(id: string): Promise<unknown> {
    return this.request('DELETE', `/api/mcp/docs/${encodeURIComponent(id)}`);
  }

  async publishDoc(id: string): Promise<unknown> {
    return this.request('POST', `/api/mcp/docs/${encodeURIComponent(id)}/publish`);
  }

  async unpublishDoc(id: string): Promise<unknown> {
    return this.request('POST', `/api/mcp/docs/${encodeURIComponent(id)}/unpublish`);
  }

  // --- Private ---

  private async request<T = any>(method: string, path: string, body?: unknown, requireAuth: boolean = true): Promise<T> {
    const url = `${this.config.apiUrl}${path}`;
    const headers: Record<string, string> = {};

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (requireAuth) {
      if (this.agentTokenOverride) {
        headers['Authorization'] = `Bearer ${this.agentTokenOverride}`;
      } else if (this.config.token) {
        headers['Authorization'] = `Bearer ${this.config.token}`;
      } else if (this.config.apiKey) {
        headers['x-api-key'] = this.config.apiKey;
      } else {
        throw new Error('Not authenticated. Run `clawrent auth login` first.');
      }
    }

    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({ message: response.statusText })) as Record<string, unknown>;
      throw new Error(`API error ${response.status}: ${errBody['message'] ?? JSON.stringify(errBody)}`);
    }

    return response.json() as Promise<T>;
  }
}
