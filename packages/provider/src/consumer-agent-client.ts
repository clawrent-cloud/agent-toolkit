import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { SessionManager } from './session-manager.js';
import { ApiClient } from './api-client.js';
import { InMemoryCursorStore } from './cursor.js';
import type { CursorStore } from './cursor.js';
import type { ActiveSession } from './types.js';

/**
 * ConsumerAgentClient — serves a consumer-owned agent in group sessions.
 *
 * Unlike `ProviderClient`, this does NOT call `activateAgent` (that endpoint
 * requires a provider profile, which consumer agents don't have). Phase 3: it
 * DOES connect /ws/agent/consumer — a push control channel symmetric to the
 * provider's /ws/agent — to receive `session.new` / `session.ended` pushes
 * (re-emitted as `control:session.new` / `control:session.ended`). The caller
 * (consumer serve daemon) uses these to discover new sessions instantly; if the
 * control channel drops, it emits `control:disconnected` and the caller's poll
 * loop is the fallback. It also connects directly to /ws/group per session,
 * dedupes inbound messages by cursor, and exposes onMessage + send (stamping
 * sender.side='consumer').
 *
 * Lifecycle: construct -> start({ sessionIds, onMessage }) -> stop().
 */
export interface ConsumerAgentClientOptions {
  apiUrl?: string;
  wsUrl?: string;
  agentToken: string;
  agentId?: string;
  cursorStore?: CursorStore;
  heartbeatIntervalMs?: number;
  maxReconnectAttempts?: number;
}

export interface ConsumerAgentCallbacks {
  onMessage: (session: ActiveSession, message: Record<string, unknown>) => void | Promise<void>;
  onSessionConnected?: (session: ActiveSession) => void;
  onSessionDead?: (session: ActiveSession, reason?: string) => void;
}

export class ConsumerAgentClient extends EventEmitter {
  private readonly client: ApiClient;
  private readonly cursor: CursorStore;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly agentToken: string;
  private agentId: string | null;
  private sessionManager: SessionManager | null = null;
  private readonly activeSessions = new Map<string, ActiveSession>();
  /** Per-session in-flight promise chain: serializes concurrent session:message
   *  frames for the same session so the cursor.set (awaited-behind) of the
   *  first call has run before the next call's dedupe check reads the cursor. */
  private readonly inflight = new Map<string, Promise<void>>();
  private boundCallbacks: ConsumerAgentCallbacks | null = null;
  private _running = false;
  // Phase 3: /ws/agent/consumer push control channel (session.new/session.ended).
  private controlWs: WebSocket | null = null;
  private controlHeartbeat: ReturnType<typeof setInterval> | null = null;
  private controlReconnect: ReturnType<typeof setTimeout> | null = null;
  private controlStopped = false;

  constructor(opts: ConsumerAgentClientOptions) {
    super();
    const config = {
      apiUrl: opts.apiUrl ?? 'https://clawrent.cloud',
      wsUrl: opts.wsUrl ?? 'wss://clawrent.cloud',
    };
    this.client = new ApiClient(config);
    this.client.setAgentToken(opts.agentToken);
    this.cursor = opts.cursorStore ?? new InMemoryCursorStore();
    this.agentToken = opts.agentToken;
    this.agentId = opts.agentId ?? null;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 25_000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
  }

  get running(): boolean { return this._running; }
  get currentAgentId(): string | null { return this.agentId; }
  /** Live set of active session ids (snapshot copy). Used by the serve
   *  discovery poll loop to diff against newly-discovered sessions. */
  get activeSessionIds(): string[] {
    return [...this.activeSessions.keys()];
  }

  async start(opts: ConsumerAgentCallbacks & { sessionIds: string[] }): Promise<void> {
    if (this._running) throw new Error('ConsumerAgentClient already started');
    if (!this.agentId) {
      const me = await this.client.getMyAgent();
      this.agentId = (me['id'] as string) ?? (me['agentId'] as string) ?? null;
    }
    if (!this.agentId) throw new Error('Could not resolve agentId (pass opts.agentId or ensure the token is valid)');

    this.boundCallbacks = opts;
    this.sessionManager = new SessionManager(
      this.client.wsUrl,
      this.heartbeatIntervalMs,
      30_000,
      this.maxReconnectAttempts,
    );
    this.sessionManager.agentId = this.agentId;
    this.bindSessionManager();

    for (const sid of opts.sessionIds) {
      this.activeSessions.set(sid, { sessionId: sid, sessionToken: '' });
      this.sessionManager.connectGroup(sid, this.agentToken);
    }
    this._running = true;
    this.connectControlChannel();
    this.emit('started', this.agentId);
  }

  /** Connect a new session after start() (used by the serve discovery poll loop).
   *  Idempotent: no-op if not running or session already active. */
  addSession(sessionId: string): void {
    if (!this._running || !this.sessionManager) return;
    if (this.activeSessions.has(sessionId)) return;
    this.activeSessions.set(sessionId, { sessionId, sessionToken: '' });
    this.sessionManager.connectGroup(sessionId, this.agentToken);
  }

  /** Deliberately drop a session: disconnect AND cancel any pending reconnect
   *  (runtime `removeSession` override — the opposite of addSession). The
   *  session can be re-added later via addSession. No-op if unknown. */
  forgetSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
    this.sessionManager?.forget(sessionId);
  }

  private bindSessionManager(): void {
    const sm = this.sessionManager;
    if (!sm) return;
    sm.on('session:connected', (sid: string) => {
      const s = this.activeSessions.get(sid);
      if (s) this.boundCallbacks?.onSessionConnected?.(s);
      this.emit('session:connected', sid);
    });
    sm.on('session:participant', (sid: string, participant: { participantId?: unknown }) => {
      const pid = participant?.participantId;
      if (typeof pid === 'string') {
        const s = this.activeSessions.get(sid);
        if (s) s.participantId = pid;
      }
      this.emit('session:participant', sid, participant);
    });
    sm.on('session:dead', (sid: string, reason: string) => {
      const active = this.activeSessions.get(sid) ?? { sessionId: sid, sessionToken: '' };
      this.activeSessions.delete(sid);
      this.boundCallbacks?.onSessionDead?.(active, reason);
    });
    sm.on('session:disconnected', (sid: string, reason: string) => {
      this.emit('session:disconnected', sid, reason);
    });
    sm.on('session:reconnecting', (sid: string, delay: number) => {
      this.emit('session:reconnecting', sid, delay);
    });
    sm.on('session:message', (sid: string, message: Record<string, unknown>) => {
      const prev = this.inflight.get(sid) ?? Promise.resolve();
      const next = prev
        .then(() => this.handleMessage(sid, message))
        .catch((err) => { this.emit('session:error', sid, err); });
      this.inflight.set(sid, next);
      next.finally(() => {
        if (this.inflight.get(sid) === next) this.inflight.delete(sid);
      });
    });
  }

  /** Per-session cursor dedupe (at-least-once). If onMessage throws, the cursor
   *  stays un-advanced so a future redelivery re-processes the message. */
  private async handleMessage(sid: string, message: Record<string, unknown>): Promise<void> {
    const cb = this.boundCallbacks?.onMessage;
    if (!cb) return;
    const meta = message['_meta'] as { timestamp?: unknown } | undefined;
    const metaTs = meta?.timestamp;
    const msgTs = message['timestamp'];
    const createdAt: string =
      typeof metaTs === 'string'
        ? metaTs
        : typeof msgTs === 'number'
          ? new Date(msgTs).toISOString()
          : new Date().toISOString();
    const last = this.cursor.get(sid);
    if (last && createdAt <= last) return; // already processed (dedupe)

    const session = this.activeSessions.get(sid) ?? { sessionId: sid, sessionToken: '' };
    try {
      await cb(session, message);
    } catch (err) {
      // Don't advance the cursor: a future redelivery must re-process this.
      this.emit('session:error', sid, err);
      return;
    }
    this.cursor.set(sid, createdAt);
  }

  /** Send an outbound message. Stamps sender.side='consumer' by default
   *  (override by passing message.sender). Returns delivered:false when the
   *  /ws/group socket isn't open. */
  async send(
    sid: string,
    message: { type: string; payload: Record<string, unknown>; mentions?: string[] },
  ): Promise<{ via: 'ws'; delivered: boolean }> {
    const sm = this.sessionManager;
    if (!sm?.isConnected(sid)) {
      this.emit('warning', `send dropped (/ws/group not open) for session ${sid}`);
      return { via: 'ws', delivered: false };
    }
    const session = this.activeSessions.get(sid);
    const sender = (message as { sender?: unknown }).sender ?? {
      participantId: session?.participantId,
      side: 'consumer' as const,
      agentId: this.agentId ?? 'unknown',
    };
    const ok = sm.send(sid, { ...message, sender });
    return { via: 'ws', delivered: ok };
  }

  /** Force-drop one session's WS (network-drop simulation, fault injection).
   *  SessionManager auto-reconnects; session/cursor state preserved. */
  forceDisconnect(sessionId: string): void {
    this.sessionManager?.forceDisconnect(sessionId);
  }

  /** Force-drop ALL active sessions at once (fault injection). Each reconnects. */
  forceDisconnectAll(): void {
    this.sessionManager?.forceDisconnectAll();
  }

  /** Phase 3: connect the /ws/agent/consumer push control channel. Reconnects on
   *  close (5s) until stop(); emits control:connected/disconnected/session.new/
   *  session.ended/error. */
  private connectControlChannel(): void {
    if (!this.agentId) return;
    this.controlStopped = false;
    const url = `${this.client.wsUrl}/ws/agent/consumer?token=${encodeURIComponent(this.agentToken)}`;
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      this.emit('control:error', err);
      this.scheduleControlReconnect();
      return;
    }
    this.controlWs = ws;

    ws.on('open', () => {
      this.emit('control:connected');
      this.controlHeartbeat = setInterval(() => {
        if (this.controlWs?.readyState === WebSocket.OPEN) {
          try { this.controlWs.send(JSON.stringify({ type: 'system.heartbeat' })); } catch { /* ignore */ }
        }
      }, this.heartbeatIntervalMs);
    });

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      const type = msg['type'];
      if (type === 'session.new') {
        this.emit('control:session.new', (msg['payload'] ?? {}) as Record<string, unknown>);
      } else if (type === 'session.ended') {
        this.emit('control:session.ended', (msg['payload'] ?? {}) as Record<string, unknown>);
      } else if (type === 'serve.rules_updated') {
        // Serve rules were re-PUT via /api/agents/me/serve-rules — the daemon
        // should re-fetch and re-evaluate its skip decisions.
        this.emit('control:rules_updated');
      }
      // agent.connected welcome / heartbeat_ack / others: ignored
    });

    ws.on('close', () => {
      this.clearControlTimers();
      this.emit('control:disconnected');
      if (!this.controlStopped) this.scheduleControlReconnect();
    });

    ws.on('error', (err) => {
      this.emit('control:error', err);
      // 'close' follows and schedules reconnect
    });
  }

  private scheduleControlReconnect(): void {
    if (this.controlStopped || !this._running) return;
    this.clearControlTimers();
    this.controlReconnect = setTimeout(() => {
      if (!this.controlStopped && this._running) this.connectControlChannel();
    }, 5_000);
  }

  private clearControlTimers(): void {
    if (this.controlHeartbeat) { clearInterval(this.controlHeartbeat); this.controlHeartbeat = null; }
    if (this.controlReconnect) { clearTimeout(this.controlReconnect); this.controlReconnect = null; }
  }

  stop(): void {
    this._running = false;
    this.controlStopped = true;
    this.clearControlTimers();
    if (this.controlWs) {
      try { this.controlWs.close(); } catch { /* ignore */ }
      this.controlWs = null;
    }
    this.sessionManager?.disconnectAll();
    this.activeSessions.clear();
    this.client.setAgentToken(null);
    this.emit('stopped');
  }
}
