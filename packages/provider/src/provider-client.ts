import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { wsAgentControlEventSchema, type WsAgentControlEvent } from '@clawrent/protocol';
import { ApiClient } from './api-client.js';
import type { ClawRentConfig } from './config.js';
import { SessionManager } from './session-manager.js';
import { InMemoryCursorStore } from './cursor.js';
import type { CursorStore } from './cursor.js';
import { resumeActiveSessions } from './helpers.js';
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
 * Task 6b wires:
 *   - bindSessionManager: forwards SessionManager events; routes session:message
 *     through handleSessionMessage (cursor dedupe -> onMessage).
 *   - resumeActive: re-attaches active provider sessions on startup.
 *   - handleAgentMessage: parses /ws/agent frames (discriminated union on `type`
 *     with fields under `payload`), routes session.new/session.approved to
 *     /ws/session connect (with optional autoApprove), and gracefully handles
 *     the non-schema frame types (agent.connected / system.error / heartbeat_ack).
 *   - handleSessionMessage: public test-hook method that dedupes inbound
 *     /ws/session messages by per-session cursor and fires onMessage.
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
  /** Callbacks captured at start(); used by handleAgentMessage/handleSessionMessage. */
  private boundCallbacks: ProviderCallbacks | null = null;

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

  private bindSessionManager(callbacks: ProviderCallbacks): void {
    this.boundCallbacks = callbacks;
    const sm = this.sessionManager;
    if (!sm) return;
    sm.on('session:connected', (sid: string) => this.emit('session:connected', sid));
    sm.on('session:disconnected', (sid: string, reason: string) => this.emit('session:disconnected', sid, reason));
    sm.on('session:message', (sid: string, message: Record<string, unknown>) => {
      void this.handleSessionMessage(sid, message);
    });
    sm.on('session:dead', (sid: string, reason: string) => {
      const active = this.activeSessions.get(sid) ?? { sessionId: sid, sessionToken: '' };
      this.activeSessions.delete(sid);
      callbacks.onSessionEnded?.(active, reason);
    });
  }

  private async resumeActive(callbacks: ProviderCallbacks): Promise<void> {
    if (!this.sessionManager) return;
    try {
      const sessions = await resumeActiveSessions(this.client, this.sessionManager);
      for (const s of sessions) {
        this.activeSessions.set(s.sessionId, s);
        callbacks.onSessionNew?.(s);
        this.emit('session:reattached', s.sessionId);
      }
    } catch (err) {
      this.emit('agent:warning', `resume failed: ${(err as Error).message}`);
    }
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
      ws.on('message', raw => {
        void this.handleAgentMessage(raw).catch(err => {
          this.emit('agent:warning', `agent message handler failed: ${(err as Error).message}`);
        });
      });
    });
  }

  /**
   * Parses an inbound /ws/agent frame and routes it.
   *
   * `session.new` / `session.approved` are validated against the protocol
   * discriminated-union schema (fields under `payload`). Other /ws/agent frame
   * types pushed by the backend (agent.connected / agent.status_updated /
   * system.error / system.heartbeat_ack — see apps/platform-api ws-agent-handler.ts)
   * are NOT in wsAgentControlEventSchema, so we route them by `type` directly
   * instead of forcing them through the schema (which would reject them).
   * Unknown types are ignored gracefully.
   *
   * Note: backend does NOT push `session.ended` on /ws/agent; session
   * terminations arrive as `system.session_ended` on /ws/session.
   */
  private async handleAgentMessage(raw: WebSocket.RawData): Promise<void> {
    let frame: unknown;
    try {
      frame = JSON.parse(raw.toString());
    } catch {
      return; // malformed JSON — ignore
    }
    if (typeof frame !== 'object' || frame === null) return;
    const type = (frame as Record<string, unknown>)['type'];

    // --- Session control events (schema-validated) ---
    if (type === 'session.new' || type === 'session.approved') {
      let parsed: WsAgentControlEvent;
      try {
        parsed = wsAgentControlEventSchema.parse(frame);
      } catch {
        return; // malformed control frame — drop, don't crash the socket
      }
      if (parsed.type === 'session.new') {
        await this.onSessionNew(parsed.payload);
      } else {
        this.onSessionApproved(parsed.payload);
      }
      return;
    }

    // --- Non-schema /ws/agent frames (route by `type` only) ---
    const payload = (frame as Record<string, unknown>)['payload'];
    switch (type) {
      case 'system.heartbeat_ack':
        return; // heartbeat acknowledgement — ignore
      case 'system.error':
        this.emit('agent:warning', `server error: ${JSON.stringify(payload)}`);
        return;
      case 'agent.connected':
        this.emit('agent:connected', payload);
        return;
      case 'agent.status_updated':
        this.emit('agent:status', payload);
        return;
      default:
        // Unknown frame type — ignore gracefully (no crash, no emit).
        return;
    }
  }

  /** session.new: register, notify host, optionally auto-approve + connect /ws/session. */
  private async onSessionNew(
    payload: Extract<WsAgentControlEvent, { type: 'session.new' }>['payload'],
  ): Promise<void> {
    const sessionId = payload.sessionId;
    const sessionToken = payload.sessionToken;
    const active: ActiveSession = {
      sessionId,
      sessionToken: sessionToken ?? '',
      taskDescription: payload.taskDescription,
      consumerUserId: payload.consumerUserId,
    };
    this.activeSessions.set(sessionId, active);
    this.boundCallbacks?.onSessionNew?.(active);
    this.emit('session:new', active);

    // Decide whether to approve + connect /ws/session now.
    const shouldApprove = this.autoApprove
      ? true
      : this.boundCallbacks?.onPendingApproval
        ? await this.boundCallbacks.onPendingApproval(active)
        : false;
    if (!shouldApprove) return;

    if (this.autoApprove) {
      try {
        await this.client.approveSession(sessionId);
      } catch (err) {
        this.emit('agent:warning', `approve failed for ${sessionId}: ${(err as Error).message}`);
        return;
      }
    }
    // SessionManager.connect is idempotent (guards on already-connected).
    // A subsequent session.approved frame will re-enter connect as a no-op.
    if (sessionToken) {
      this.sessionManager?.connect(sessionId, sessionToken);
    } else {
      this.emit('agent:warning', `session.new for ${sessionId} carried no sessionToken; deferring /ws/session connect until session.approved`);
    }
  }

  /** session.approved: ensure tracked + connect /ws/session (idempotent). */
  private onSessionApproved(
    payload: Extract<WsAgentControlEvent, { type: 'session.approved' }>['payload'],
  ): void {
    const sessionId = payload.sessionId;
    const sessionToken = payload.sessionToken;
    const existing = this.activeSessions.get(sessionId);
    const active: ActiveSession = existing ?? {
      sessionId,
      sessionToken: sessionToken ?? '',
    };
    if (sessionToken) active.sessionToken = sessionToken;
    this.activeSessions.set(sessionId, active);
    this.emit('session:approved', active);
    if (sessionToken) {
      this.sessionManager?.connect(sessionId, sessionToken);
    }
  }

  /**
   * Dedupes an inbound /ws/session message by per-session cursor, then invokes
   * the host's onMessage callback. Public (no underscore prefix) so the
   * integration test can drive the cursor/dedupe path directly as a hook.
   *
   * The cursor is advanced BEFORE the await on onMessage so that two deliveries
   * of the same frame in the same tick (e.g. a WS redelivery) collapse to a
   * single onMessage call. Tradeoff: if onMessage throws, the cursor is already
   * advanced and this mechanism will not redeliver — hosts needing stronger
   * at-least-once semantics should retry via REST. `createdAt` is canonical UTC
   * ISO, taken from `_meta.timestamp` (backend pushes ISO `...Z`) with a
   * `new Date(message.timestamp).toISOString()` fallback (ms epoch).
   */
  async handleSessionMessage(sessionId: string, message: Record<string, unknown>): Promise<void> {
    const onMessage = this.boundCallbacks?.onMessage;
    if (!onMessage) return;

    const meta = message['_meta'] as { timestamp?: unknown } | undefined;
    const metaTs = meta?.timestamp;
    const msgTs = message['timestamp'];
    const createdAt: string =
      typeof metaTs === 'string'
        ? metaTs
        : typeof msgTs === 'number'
          ? new Date(msgTs).toISOString()
          : new Date().toISOString();

    const last = this.cursor.get(sessionId);
    if (last && createdAt <= last) return; // already processed (dedupe)

    this.cursor.set(sessionId, createdAt); // advance FIRST (sync dedupe)

    const session = this.activeSessions.get(sessionId) ?? { sessionId, sessionToken: '' };
    try {
      await onMessage(session, message);
    } catch (err) {
      this.emit('session:error', sessionId, err);
    }
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
