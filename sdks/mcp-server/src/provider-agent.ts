import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ApiClient, SessionManager } from '@clawrent/cli';

export interface ActiveSession {
  sessionId: string;
  sessionToken: string;
  taskDescription: string;
  consumerUserId?: string;
  slotIndex?: number;
}

/**
 * ProviderAgent runs an in-process WebSocket connection to the
 * /ws/agent control channel, replacing the need to spawn a CLI subprocess.
 * It manages session lifecycle and delegates session-level WS to SessionManager.
 */
export class ProviderAgent extends EventEmitter {
  private client: ApiClient;
  private agentWs: WebSocket | null = null;
  private sessionManager: SessionManager | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private _running = false;

  private agentId: string | null = null;
  private agentToken: string | null = null;
  private autoApprove = false;
  private activeSessions = new Map<string, ActiveSession>();

  constructor(client: ApiClient) {
    super();
    this.client = client;
  }

  get running(): boolean {
    return this._running;
  }

  get currentAgentId(): string | null {
    return this.agentId;
  }

  getSessions(): ActiveSession[] {
    return Array.from(this.activeSessions.values());
  }

  /**
   * Start the in-process agent: connect to /ws/agent and listen for sessions.
   */
  async start(agentId: string, agentToken: string, autoApprove = false): Promise<void> {
    if (this._running) {
      throw new Error(`Already serving agent ${this.agentId}`);
    }

    this.agentId = agentId;
    this.agentToken = agentToken;
    this.autoApprove = autoApprove;
    this._running = true;
    this.reconnectAttempts = 0;

    // Create session manager for per-session WS connections
    this.sessionManager = new SessionManager(this.client.wsUrl);
    this.sessionManager.agentId = agentId;

    this.sessionManager.on('session:connected', (sessionId: string) => {
      this.emit('session:connected', sessionId);
    });

    this.sessionManager.on('session:message', (sessionId: string, message: Record<string, unknown>) => {
      this.emit('session:message', sessionId, message);
    });

    this.sessionManager.on('session:disconnected', (sessionId: string) => {
      this.activeSessions.delete(sessionId);
      this.emit('session:disconnected', sessionId);
    });

    // Route REST calls (approve/list/end + internal autoApprove) through the
    // agent token — the backend resolves agt_clawrent_* to the agent owner,
    // so provider tools work without a separate user JWT login.
    this.client.setAgentToken(agentToken);

    this.connectAgent();

    // Re-attach to active sessions that existed before this process started
    // (e.g. after MCP/connector restart). Best-effort — failures don't block serving.
    void this.reattachActiveSessions().catch(() => {
      // errors already surfaced via 'agent:error'
    });
  }

  /**
   * Stop the agent: disconnect all sessions and the control channel.
   */
  stop(): void {
    this._running = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.sessionManager?.disconnectAll();
    this.sessionManager = null;

    if (this.agentWs && (this.agentWs.readyState === WebSocket.OPEN || this.agentWs.readyState === WebSocket.CONNECTING)) {
      this.agentWs.close(1000, 'Agent stopping');
    }
    this.agentWs = null;

    this.activeSessions.clear();
    this.agentId = null;
    this.agentToken = null;
    this.client.setAgentToken(null);

    this.emit('stopped');
  }

  /**
   * Send a message to a specific session.
   */
  send(sessionId: string, message: Record<string, unknown>): boolean {
    if (!this.sessionManager) return false;
    return this.sessionManager.send(sessionId, message);
  }

  /**
   * Send a message via WS if attached, else fall back to REST POST.
   * Never fails with "not attached" — uses REST instead. Returns the transport used.
   */
  async sendViaWsOrRest(
    sessionId: string,
    message: { type: string; payload: Record<string, unknown> },
  ): Promise<{ via: 'ws' | 'rest' }> {
    if (this.sessionManager?.isConnected(sessionId)) {
      const ok = this.sessionManager.send(sessionId, message);
      if (ok) return { via: 'ws' };
    }
    await this.client.sendSessionMessage(sessionId, message);
    return { via: 'rest' };
  }

  /**
   * Re-attach WS to active provider sessions (e.g. after MCP process restart).
   * Pulls active sessions from the platform and connects each; refills the
   * in-memory activeSessions map so serving_status / session.approved paths work.
   * Failures are isolated — one stale sessionToken won't block the others.
   */
  async reattachActiveSessions(): Promise<void> {
    const sm = this.sessionManager;
    if (!this._running || !sm) return;
    try {
      const res = (await this.client.getSessions({ role: 'provider', status: 'active' })) as {
        data?: Array<{
          id: string;
          sessionToken?: string;
          taskDescription?: string;
          consumerUserId?: string;
        }>;
      };
      const active = res?.data ?? [];
      if (active.length === 0) return;

      const results = await Promise.allSettled(
        active.map((s) => {
          if (!s.sessionToken) {
            throw new Error(`list response missing sessionToken for session ${s.id}`);
          }
          this.activeSessions.set(s.id, {
            sessionId: s.id,
            sessionToken: s.sessionToken,
            taskDescription: s.taskDescription ?? '',
            consumerUserId: s.consumerUserId,
          });
          sm.connect(s.id, s.sessionToken);
          this.emit('session:reattached', s.id);
        }),
      );
      const failed = results.filter((r) => r.status === 'rejected').length;
      if (failed > 0) {
        this.emit(
          'agent:error',
          new Error(`reattach: ${failed}/${active.length} sessions failed to attach`),
        );
      }
    } catch (err) {
      this.emit('agent:error', err instanceof Error ? err : new Error(String(err)));
    }
  }

  private connectAgent(): void {
    if (!this._running || !this.agentToken) return;

    const url = `${this.client.wsUrl}/ws/agent?token=${this.agentToken}`;
    const ws = new WebSocket(url);
    this.agentWs = ws;

    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.emit('agent:connected', this.agentId);

      // Start heartbeat
      this.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'system.heartbeat', payload: {} }));
        }
      }, 25_000);
    });

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
        this.handleAgentMessage(msg);
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', (code) => {
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }

      this.emit('agent:disconnected', this.agentId);

      // Reconnect on abnormal close if still running
      if (this._running && code !== 1000) {
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), this.maxReconnectDelay);
        this.reconnectAttempts++;
        this.reconnectTimer = setTimeout(() => this.connectAgent(), delay);
      }
    });

    ws.on('error', (err) => {
      this.emit('agent:error', err);
    });
  }

  private handleAgentMessage(msg: Record<string, unknown>): void {
    const type = msg['type'] as string;

    if (type === 'system.heartbeat_ack') return;

    if (type === 'session.new') {
      const payload = msg['payload'] as Record<string, unknown>;
      const sessionId = payload['sessionId'] as string;
      const sessionToken = payload['sessionToken'] as string;
      const taskDescription = (payload['taskDescription'] as string) || '';
      const consumerUserId = payload['consumerUserId'] as string | undefined;

      const session: ActiveSession = {
        sessionId, sessionToken, taskDescription, consumerUserId,
        slotIndex: (payload['slotIndex'] as number) ?? 0,
      };
      this.activeSessions.set(sessionId, session);

      this.emit('session:new', session);

      if (this.autoApprove) {
        // Auto-approve and connect
        this.client.approveSession(sessionId).then(() => {
          this.sessionManager?.connect(sessionId, sessionToken);
          this.emit('session:approved', sessionId);
        }).catch((err) => {
          this.emit('session:error', sessionId, err);
        });
      }
    } else if (type === 'session.approved') {
      const payload = msg['payload'] as Record<string, unknown>;
      const sessionId = payload['sessionId'] as string;
      const session = this.activeSessions.get(sessionId);
      if (session) {
        this.sessionManager?.connect(sessionId, session.sessionToken);
      }
    }
  }
}
