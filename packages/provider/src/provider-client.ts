import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ApiClient } from './api-client.js';
import type { ClawRentConfig } from './config.js';
import { SessionManager } from './session-manager.js';
import { InMemoryCursorStore } from './cursor.js';
import type { CursorStore } from './cursor.js';
import type { ActiveSession } from './types.js';

export interface ProviderClientOptions {
  apiUrl?: string;
  wsUrl?: string;
  agentToken: string;
  cursorStore?: CursorStore;
  heartbeatIntervalMs?: number;
  maxReconnectAttempts?: number;
  autoApprove?: boolean;
}

export interface ProviderCallbacks {
  onMessage: (session: ActiveSession, message: Record<string, unknown>) => void | Promise<void>;
  onSessionNew?: (session: ActiveSession) => void;
  onSessionEnded?: (session: ActiveSession, reason?: string) => void;
  onPendingApproval?: (session: ActiveSession) => boolean | Promise<boolean>;
  agentId?: string;
}

/**
 * ProviderClient — the core embeddable class of @clawrent/provider.
 *
 * Lifecycle (Task 6a scope):
 *   construct -> start() -> connects /ws/agent (presence) + activates the agent
 *            -> stop() disconnects everything cleanly.
 *
 * Task 6b fills bindSessionManager / resumeActive / handleAgentMessage
 * (session.new routing, cursor dedupe, re-attach). They are intentionally
 * stubs here — staged implementation, not placeholder.
 */
export class ProviderClient extends EventEmitter {
  private readonly client: ApiClient;
  private readonly cursor: CursorStore;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly autoApprove: boolean;
  private agentToken: string;
  private agentId: string | null = null;
  private agentWs: WebSocket | null = null;
  private sessionManager: SessionManager | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private readonly activeSessions = new Map<string, ActiveSession>();

  constructor(opts: ProviderClientOptions) {
    super();
    const config: ClawRentConfig = {
      apiUrl: opts.apiUrl ?? 'https://clawrent.cloud',
      wsUrl: opts.wsUrl ?? 'wss://clawrent.cloud',
    };
    this.client = new ApiClient(config);
    this.client.setAgentToken(opts.agentToken);
    this.agentToken = opts.agentToken;
    this.cursor = opts.cursorStore ?? new InMemoryCursorStore();
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 25_000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.autoApprove = opts.autoApprove ?? true;
  }

  get running(): boolean { return this._running; }
  get currentAgentId(): string | null { return this.agentId; }
  /** Cursor store used for per-session message dedupe (wired in Task 6b). */
  get cursorStore(): CursorStore { return this.cursor; }
  /** Whether sessions are auto-approved on arrival (wired in Task 6b). */
  get isAutoApprove(): boolean { return this.autoApprove; }

  async start(callbacks: ProviderCallbacks): Promise<void> {
    if (this._running) throw new Error('ProviderClient already started');

    // resolve agentId
    if (callbacks.agentId) {
      this.agentId = callbacks.agentId;
    } else {
      const me = await this.client.getMyAgent();
      this.agentId = (me['id'] as string) ?? (me['agentId'] as string) ?? null;
    }
    if (!this.agentId) throw new Error('Could not resolve agentId (pass callbacks.agentId or ensure token is valid)');

    // wire session manager
    this.sessionManager = new SessionManager(this.client.wsUrl, this.heartbeatIntervalMs, 30_000, this.maxReconnectAttempts);
    this.sessionManager.agentId = this.agentId;
    this.bindSessionManager(callbacks);

    // connect /ws/agent (control channel -> presence)
    await this.connectAgent();

    // activate (WS now connected -> isAgentConnected gate passes).
    // Failure is tolerated: profile may not be admin-approved yet, but WS
    // presence is up so the agent is reachable. Warn, don't crash.
    try {
      await this.client.activateAgent(this.agentId);
    } catch (err) {
      this.emit('agent:warning', `activation failed: ${(err as Error).message}`);
    }

    this._running = true;
    this.emit('agent:started', this.agentId);

    // re-attach active sessions (Task 6b expands this)
    void this.resumeActive(callbacks);
  }

  private bindSessionManager(_callbacks: ProviderCallbacks): void {
    // expanded in Task 6b (session:message -> cursor dedupe -> onMessage)
  }

  private async resumeActive(_callbacks: ProviderCallbacks): Promise<void> {
    // expanded in Task 6b via helpers.resumeActiveSessions
  }

  private connectAgent(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.client.wsUrl}/ws/agent?token=${encodeURIComponent(this.agentToken)}`;
      const ws = new WebSocket(url);
      this.agentWs = ws;
      ws.on('open', () => {
        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'system.heartbeat', payload: {} }));
          }
        }, this.heartbeatIntervalMs);
        this.emit('agent:connected');
        resolve();
      });
      ws.on('error', reject);
      ws.on('close', (code, reason) => {
        this.emit('agent:disconnected', code, reason.toString());
        // exponential backoff reconnect guarded by running (expanded in Task 6b; keep simple here)
      });
      ws.on('message', raw => this.handleAgentMessage(raw));
    });
  }

  private handleAgentMessage(_raw: WebSocket.RawData): void {
    // expanded in Task 6b (session.new/approved/ended -> connect /ws/session, callbacks)
  }

  stop(): void {
    this._running = false;
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    this.sessionManager?.disconnectAll();
    if (this.agentWs) { this.agentWs.close(1000, 'Provider stopping'); this.agentWs = null; }
    this.activeSessions.clear();
    this.client.setAgentToken(null);
    this.emit('stopped');
  }
}
