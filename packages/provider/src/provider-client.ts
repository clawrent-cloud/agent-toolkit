import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { ControlSignalType, wsAgentControlEventSchema, type WsAgentControlEvent } from '@clawrent/protocol';
import { ApiClient } from './api-client.js';
import type { ClawRentConfig } from './config.js';
import { SessionManager } from './session-manager.js';
import { InMemoryCursorStore } from './cursor.js';
import type { CursorStore } from './cursor.js';
import { resumeActiveSessions } from './helpers.js';
import type { ActiveSession } from './types.js';

/** Backend /ws/agent close codes that mean the connection can never be
 *  re-established — stop reconnecting. From apps/platform-api ws-agent-handler.ts:
 *  4000 missing token, 4001 invalid agent token. (Different from /ws/session's
 *  4000-4004 set — SessionManager uses its own; do not share.) */
const AGENT_TERMINAL_CLOSE_CODES = new Set([4000, 4001]);

export interface ProviderClientOptions {
  apiUrl?: string;
  wsUrl?: string;
  agentToken: string;
  cursorStore?: CursorStore;
  heartbeatIntervalMs?: number;
  maxReconnectAttempts?: number;
  autoApprove?: boolean;
  /** Initial backoff for presence REST retries (getMyAgent/activateAgent). Default 1000ms. */
  restRetryInitialMs?: number;
  /** Cap for presence REST retry backoff. Default 30000ms. */
  restRetryMaxDelayMs?: number;
  /** Max attempts for presence REST retries. undefined = persistent (default, for unattended providers). */
  restRetryMaxAttempts?: number;
  /** Initial backoff for /ws/agent reconnect. Default 1000ms. */
  agentReconnectInitialMs?: number;
  /** Cap for /ws/agent reconnect backoff. Default 30000ms. */
  agentReconnectMaxDelayMs?: number;
  /** Max wait for the backend's agent.connected welcome before falling back to a
   *  direct activate (#4). Default 5000ms. The welcome normally arrives within ms;
   *  the timeout only guards half-open sockets in pathological cases. */
  activateWelcomeTimeoutMs?: number;
  /** Opt into the participant-scoped /ws/group channel (Plan 4b) instead of the
   *  legacy /ws/session one. When true, session WS connect via connectGroup with
   *  agentToken auth (no sessionToken needed) and the server-assigned participantId
   *  is cached on each ActiveSession. Default false (fully backward compatible). */
  useGroupChannel?: boolean;
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
  private readonly restRetryInitialMs: number;
  private readonly restRetryMaxDelayMs: number;
  private readonly restRetryMaxAttempts: number | undefined;
  private readonly agentReconnectInitialMs: number;
  private readonly agentReconnectMaxDelayMs: number;
  private readonly activateWelcomeTimeoutMs: number;
  /** Opt into /ws/group (participant-scoped) instead of /ws/session. */
  private readonly useGroupChannel: boolean;
  /** /ws/agent reconnect state. */
  private agentReconnectAttempts = 0;
  private agentReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private agentToken: string;
  private agentId: string | null = null;
  private agentWs: WebSocket | null = null;
  private sessionManager: SessionManager | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _stopped = false;
  private readonly activeSessions = new Map<string, ActiveSession>();
  /**
   * Per-session in-flight promise chain: each `session:message` for the same
   * sessionId is chained onto the previous one so calls serialize. Without this,
   * two socket frames arriving in the same tick would both pass the cursor
   * dedupe check (the first call's `cursor.set` is queued behind its `await`
   * and hasn't run when the second call reads the cursor) and onMessage would
   * fire twice. The Map entry is cleared when the tail settles so it doesn't
   * grow unbounded.
   */
  private readonly inflight = new Map<string, Promise<void>>();
  /** Callbacks captured at start(); used by handleAgentMessage/handleSessionMessage. */
  private boundCallbacks: ProviderCallbacks | null = null;
  /** Per-session last-sent timestamp for sendTyping debounce (guard against
   * hosts calling in a tight loop; hosts wanting a steady indicator should
   * call every ~2s — the peer clears the indicator after a 3s gap). */
  private readonly lastTypingSent = new Map<string, number>();
  /** One-shot latch: settles (resolve on first success / reject on terminal 4xx)
   *  when the FIRST activateAgent completes. start() awaits it (α semantics).
   *  Reused across reconnects but only the first settle matters; later calls are no-ops. */
  private firstActivationResolve!: () => void;
  private firstActivationReject!: (err: unknown) => void;
  private readonly firstActivation: Promise<void> = new Promise((resolve, reject) => {
    this.firstActivationResolve = resolve;
    this.firstActivationReject = reject;
  });
  /** Per-connection latch: resolves when the backend's agent.connected welcome
   *  frame arrives on THIS socket. Reset on every open so each (re)connect waits
   *  for its own welcome (#4). */
  private agentWelcomeResolve!: () => void;
  private agentWelcome: Promise<void> = new Promise(r => { this.agentWelcomeResolve = r; });

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
    this.restRetryInitialMs = opts.restRetryInitialMs ?? 1_000;
    this.restRetryMaxDelayMs = opts.restRetryMaxDelayMs ?? 30_000;
    this.restRetryMaxAttempts = opts.restRetryMaxAttempts; // undefined => persistent
    this.agentReconnectInitialMs = opts.agentReconnectInitialMs ?? 1_000;
    this.agentReconnectMaxDelayMs = opts.agentReconnectMaxDelayMs ?? 30_000;
    this.activateWelcomeTimeoutMs = opts.activateWelcomeTimeoutMs ?? 5_000;
    this.useGroupChannel = opts.useGroupChannel ?? false;
  }

  get running(): boolean { return this._running; }
  get currentAgentId(): string | null { return this.agentId; }
  /** Cursor store used for per-session message dedupe (wired in Task 6b). */
  get cursorStore(): CursorStore { return this.cursor; }
  /** Whether sessions are auto-approved on arrival (wired in Task 6b). */
  get isAutoApprove(): boolean { return this.autoApprove; }

  async start(callbacks: ProviderCallbacks): Promise<void> {
    if (this._running) throw new Error('ProviderClient already started');

    // resolve agentId (with retry — symptom A fix: transient fetch blip at startup
    // no longer kills the provider).
    if (callbacks.agentId) {
      this.agentId = callbacks.agentId;
    } else {
      const me = await this.retryWithBackoff(
        () => this.client.getMyAgent(),
        {
          initialMs: this.restRetryInitialMs,
          maxDelayMs: this.restRetryMaxDelayMs,
          maxAttempts: this.restRetryMaxAttempts,
          isCancelled: () => this._stopped,
          onRetry: (a, err, delay) => this.emit('agent:warning', `getMyAgent attempt ${a} failed: ${(err as Error).message}; retry in ${delay}ms`),
        },
      );
      this.agentId = (me['id'] as string) ?? (me['agentId'] as string) ?? null;
    }
    if (!this.agentId) throw new Error('Could not resolve agentId (pass callbacks.agentId or ensure token is valid)');

    // wire session manager
    this.sessionManager = new SessionManager(this.client.wsUrl, this.heartbeatIntervalMs, 30_000, this.maxReconnectAttempts);
    this.sessionManager.agentId = this.agentId;
    this.bindSessionManager(callbacks);

    // connect /ws/agent (control channel -> presence). Fire-and-forget the connect
    // promise: a first-connect failure no longer rejects start() — connectAgent
    // routes it through scheduleAgentReconnect (#1), and start() awaits
    // firstActivation below (open -> activate -> resolve) regardless.
    void this.connectAgent();

    // α: wait for the first successful activation before declaring running.
    // On terminal 4xx activation, firstActivation rejects -> start() rejects
    // (bad token / not approved won't self-heal; plugin logs startProvider failed).
    await this.firstActivation;

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
      // Per-session serialization: chain this call onto the previous one for
      // the same sessionId so two frames arriving in the same tick do not both
      // pass the cursor dedupe check inside handleSessionMessage. The .catch
      // also covers Fix 3 — if a cursor-op (cursor.get/set) itself throws, the
      // rejection is caught here and surfaced as session:error instead of
      // becoming an unhandled rejection.
      const prev = this.inflight.get(sid) ?? Promise.resolve();
      const next = prev
        .then(() => this.handleSessionMessage(sid, message))
        .catch(err => { this.emit('session:error', sid, err); });
      this.inflight.set(sid, next);
      next.finally(() => {
        if (this.inflight.get(sid) === next) this.inflight.delete(sid);
      });
    });
    sm.on('session:dead', (sid: string, reason: string) => {
      const active = this.activeSessions.get(sid) ?? { sessionId: sid, sessionToken: '' };
      this.activeSessions.delete(sid);
      callbacks.onSessionEnded?.(active, reason);
    });
    sm.on('session:participant', (sid: string, participant: { participantId?: unknown }) => {
      // Cache the server-assigned participantId (group mode) so the host can do
      // @-routing and outbound envelopes can stamp sender.participantId.
      const pid = participant?.participantId;
      if (typeof pid === 'string') {
        const active = this.activeSessions.get(sid);
        if (active) active.participantId = pid;
      }
      this.emit('session:participant', sid, participant);
    });
    sm.on('session:presence', (sid: string, frame: Record<string, unknown>) => {
      // Presence/ack frames (participant_joined/left, message_ack, blocked) —
      // forwarded for host observability but never trigger onMessage.
      this.emit('session:presence', sid, frame);
    });
  }

  private async resumeActive(callbacks: ProviderCallbacks): Promise<void> {
    if (!this.sessionManager) return;
    try {
      const sessions = await resumeActiveSessions(this.client, this.sessionManager, {
        useGroupChannel: this.useGroupChannel,
        agentToken: this.agentToken,
      });
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
    return new Promise((resolve) => {
      const url = `${this.client.wsUrl}/ws/agent?token=${encodeURIComponent(this.agentToken)}`;
      const ws = new WebSocket(url);
      this.agentWs = ws;
      ws.on('open', () => {
        this.heartbeatTimer = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'system.heartbeat', payload: {} }));
          }
        }, this.heartbeatIntervalMs);
        // Reset the welcome latch for THIS connection: each (re)connect waits for
        // its own agent.connected before activating (#4).
        this.agentWelcome = new Promise<void>(r => { this.agentWelcomeResolve = r; });
        this.emit('agent:connected');
        this.agentReconnectAttempts = 0; // (re)connected — reset reconnect backoff
        void this.activateAfterWelcome(); // #4: wait for agent.connected, then activate
        resolve();
      });
      ws.on('error', () => {
        // 'error' is always followed by 'close', whose handler schedules the
        // reconnect for both first-connect and reconnect failures (single source
        // of truth — avoids a double schedule). We no longer reject start() on a
        // first-connect failure (#1): start() awaits firstActivation, which
        // resolves once a retry connect reaches open.
      });
      ws.on('close', (code, reason) => {
        this.clearHeartbeat();
        this.emit('agent:disconnected', code, reason.toString());
        if (this._stopped) return; // tearing down — don't reconnect
        if (AGENT_TERMINAL_CLOSE_CODES.has(code)) {
          this._running = false; // terminal = unrecoverable; reflect in the public getter (don't full-stop; host owns teardown)
          this.emit('agent:dead', this.agentId, `terminal close ${code}: ${reason.toString()}`);
          return; // bad token etc. — won't fix, don't loop
        }
        this.scheduleAgentReconnect();
      });
      ws.on('message', raw => {
        void this.handleAgentMessage(raw).catch(err => {
          this.emit('agent:warning', `agent message handler failed: ${(err as Error).message}`);
        });
      });
    });
  }

  /**
   * Reconnect /ws/agent after an abnormal (non-terminal) close. Persistent
   * (never gives up) with exponential backoff capped at agentReconnectMaxDelayMs.
   * Guarded by _running: stop() cancels. On the new socket's 'open', the existing
   * open handler resets attempts + fires activateWithRetry (re-activation).
   */
  private scheduleAgentReconnect(): void {
    if (this._stopped) return;
    const delay = Math.min(
      this.agentReconnectInitialMs * 2 ** this.agentReconnectAttempts,
      this.agentReconnectMaxDelayMs,
    );
    this.agentReconnectAttempts++;
    this.emit('agent:reconnecting', delay);
    this.agentReconnectTimer = setTimeout(() => {
      this.agentReconnectTimer = null;
      if (this._stopped) return;
      // Fire-and-forget: open handler activates; errors route back to close → reschedule.
      void this.connectAgent().catch(() => { /* close handler reschedules */ });
    }, delay);
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
        this.emit('agent:warning', `server error: ${JSON.stringify(payload) ?? 'no payload'}`);
        return;
      case 'agent.connected':
        this.agentWelcomeResolve(); // #4: welcome received -> unlock activateAfterWelcome
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
      guardrailDecision: payload.guardrailDecision,
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
    // SessionManager.connect/connectGroup are idempotent (guard on already-connected).
    // A subsequent session.approved frame will re-enter as a no-op.
    if (this.useGroupChannel) {
      // /ws/group: agentToken auth (no sessionToken needed). The participantId is
      // assigned by the server on connect and cached via session:participant.
      this.sessionManager?.connectGroup(sessionId, this.agentToken);
    } else if (sessionToken) {
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
    if (this.useGroupChannel) {
      this.sessionManager?.connectGroup(sessionId, this.agentToken);
    } else if (sessionToken) {
      this.sessionManager?.connect(sessionId, sessionToken);
    }
  }

  /**
   * Dedupes an inbound /ws/session message by per-session cursor, then invokes
   * the host's onMessage callback. Public (no underscore prefix) so the
   * integration test can drive the cursor/dedupe path directly as a hook.
   *
   * At-least-once invariant (Task 6b fix round 1): the cursor is advanced ONLY
   * AFTER `await onMessage` completes successfully. If onMessage throws, the
   * cursor is left un-advanced and `session:error` is emitted — so a future
   * redelivery (e.g. backend replay on restart) will pass the dedupe check and
   * re-process the message. onMessage MUST be idempotent precisely because of
   * this redelivery semantics. The per-session in-flight chain in
   * `bindSessionManager`'s `session:message` handler serializes concurrent
   * frames for the same session so the cursor-after-success commit has a chance
   * to run before the next frame's dedupe check reads the cursor.
   *
   * `createdAt` is canonical UTC ISO, taken from `_meta.timestamp` (backend
   * pushes ISO `...Z`) with a `new Date(message.timestamp).toISOString()`
   * fallback (ms epoch).
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

    const session = this.activeSessions.get(sessionId) ?? { sessionId, sessionToken: '' };
    try {
      await onMessage(session, message);
    } catch (err) {
      // Do NOT advance the cursor: a future redelivery must re-process this
      // message (at-least-once across the onMessage failure).
      this.emit('session:error', sessionId, err);
      return;
    }
    this.cursor.set(sessionId, createdAt); // success → advance + persist
  }

  /**
   * Send an outbound message to a session. Prefers the /ws/session socket when
   * it is OPEN (low latency, no HTTP overhead); falls back to the REST
   * `POST /api/sessions/:id/messages` endpoint when the socket is absent or not
   * yet open (e.g. before start(), during reconnect, or for sessions not yet
   * attached). Returns the transport actually used so callers can observe it.
   *
   * Note: this method does NOT throw when WS is unavailable — it silently falls
   * back to REST. REST errors propagate to the caller as-is.
   */
  async send(
    sessionId: string,
    message: { type: string; payload: Record<string, unknown>; mentions?: string[] },
  ): Promise<{ via: 'ws' | 'rest' }> {
    // Local binding so TS narrows `sm` to NonNullable inside the if-block
    // (this.sessionManager is mutable class state and isn't narrowed by `?.`).
    const sm = this.sessionManager;
    if (sm?.isConnected(sessionId)) {
      // Pass the full message (incl. mentions) so the group-mode envelope can
      // stamp the top-level mentions array; the session-mode envelope ignores it.
      const ok = sm.send(sessionId, message);
      if (ok) return { via: 'ws' };
    }
    // REST fallback — sendSessionMessage's body has no mentions field, and WS is
    // the group-mode path, so mentions are dropped here (REST is a session-mode
    // fallback only).
    await this.client.sendSessionMessage(sessionId, { type: message.type, payload: message.payload });
    return { via: 'rest' };
  }

  /**
   * Send a transient "typing" indicator to a session. Fire-and-forget over the
   * /ws/session socket ONLY — never REST (the REST POST /messages endpoint does
   * NOT short-circuit dialogue.typing, so it would persist a typing row and
   * pollute message history). The backend forwards the frame to the peer and
   * skips validation/persistence/metering/ACK.
   *
   * Debounced to one send per 500ms per session as a guard against hosts
   * calling in a tight loop. No-op (returns false) when the session socket is
   * not OPEN or the call is suppressed by debounce; returns true when a typing
   * frame was actually sent.
   *
   * Hosts control timing: call this periodically (every ~2s) after receiving a
   * consumer message and while generating a reply; stop once the reply is sent.
   */
  sendTyping(sessionId: string): boolean {
    // Group mode: /ws/group has no typing short-circuit (ws-group-handler persists
    // dialogue.typing into message history) — typing is disabled (Plan 4b decision 3).
    // The backend may add a typing short-circuit in a later version; until then no-op.
    if (this.useGroupChannel) return false;
    const sm = this.sessionManager;
    if (!sm?.isConnected(sessionId)) return false;
    const now = Date.now();
    const last = this.lastTypingSent.get(sessionId) ?? 0;
    if (now - last < 500) return false;
    this.lastTypingSent.set(sessionId, now);
    return sm.send(sessionId, { type: ControlSignalType.DIALOGUE_TYPING, payload: {} });
  }

  /**
   * setTimeout-based sleep that resolves early if `isCancelled` flips true,
   * polled every ~50ms. Lets `stop()` (or any cancel signal) interrupt an
   * in-progress backoff sleep instead of stalling up to `maxDelayMs` (30s).
   * The caller's loop-top `isCancelled` check then throws 'cancelled'.
   */
  private cancellableSleep(delayMs: number, isCancelled?: () => boolean): Promise<void> {
    if (!isCancelled) return new Promise(r => setTimeout(r, delayMs));
    return new Promise<void>(resolve => {
      const end = Date.now() + delayMs;
      const tick = (): void => {
        if (isCancelled() || Date.now() >= end) { resolve(); return; }
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  /**
   * Retry with exponential backoff. Used to harden presence-critical REST calls
   * (getMyAgent, activateAgent) against transient network failures.
   *
   * Public (no `private` keyword) so tests can drive it directly via bracket
   * access as a hook — matches the `handleSessionMessage` precedent. Tasks 3-5
   * will wire it into `start()`; until then it has no internal call site, which
   * is why it cannot be `private` (TS6133 under `noUnusedLocals`).
   *
   * - maxAttempts === undefined => persistent (never gives up) — the default for
   *   unattended providers with no external restart.
   * - Terminal REST errors (4xx except 429) throw immediately — bad tokens won't
   *   fix themselves.
   * - Network errors / 5xx / 429 retry with exponential backoff capped at
   *   maxDelayMs. onRetry (if set) fires BEFORE each sleep so callers can emit.
   */
  async retryWithBackoff<T>(
    fn: () => Promise<T>,
    opts: {
      initialMs: number;
      maxDelayMs: number;
      maxAttempts?: number;
      onRetry?: (attempt: number, err: unknown, delayMs: number) => void;
      isCancelled?: () => boolean;
    },
  ): Promise<T> {
    let attempt = 0;
    // maxAttempts undefined => persistent
    while (opts.maxAttempts === undefined || attempt < opts.maxAttempts) {
      if (opts.isCancelled?.()) throw new Error('cancelled');
      try {
        return await fn();
      } catch (err) {
        attempt++;
        if (this.isTerminalRestError(err)) throw err;
        if (opts.maxAttempts !== undefined && attempt >= opts.maxAttempts) throw err;
        const delay = Math.min(opts.initialMs * 2 ** (attempt - 1), opts.maxDelayMs);
        opts.onRetry?.(attempt, err, delay);
        await this.cancellableSleep(delay, opts.isCancelled);
      }
    }
    // unreachable (loop covers all paths), but satisfies TS return type
    throw new Error('retryWithBackoff: exhausted');
  }

  /** 4xx (except 429) are terminal — auth/validation won't self-heal. */
  private isTerminalRestError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const m = err.message.match(/^API error (\d+):/);
    if (!m) return false; // network error (no API status) => retry
    const status = Number(m[1]);
    return status >= 400 && status < 500 && status !== 429;
  }

  /**
   * Wait for the backend's `agent.connected` welcome frame, then activate.
   * Backend order (ws-agent-handler.ts): registerAgentClient (join connected set)
   * THEN send welcome — so receiving the welcome guarantees isAgentConnected=true,
   * eliminating the activate-vs-register race that produced the transient 400
   * "Agent is not connected via WebSocket" (#4). A conservative timeout falls back
   * to a direct activate (degrades to the pre-#4 behavior; never worse).
   */
  private async activateAfterWelcome(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.agentWelcome,
        new Promise<void>(r => { timer = setTimeout(r, this.activateWelcomeTimeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    await this.activateWithRetry();
  }

  /**
   * Activate the agent with persistent retry. Called on every /ws/agent (re)connect.
   * Emits: agent:warning per failed attempt; agent:activated on success;
   * agent:activation:failed on terminal 4xx (or maxAttempts exhausted).
   * On the FIRST connect (before _running), settles firstActivation:
   *   success -> resolve (start() proceeds); terminal -> reject (start() rejects).
   * On reconnects (_running true), just emits (firstActivation already settled).
   */
  private async activateWithRetry(): Promise<void> {
    if (!this.agentId) return;
    try {
      await this.retryWithBackoff(
        () => this.client.activateAgent(this.agentId!),
        {
          initialMs: this.restRetryInitialMs,
          maxDelayMs: this.restRetryMaxDelayMs,
          maxAttempts: this.restRetryMaxAttempts,
          isCancelled: () => this._stopped,
          onRetry: (a, err, delay) => this.emit('agent:warning', `activation attempt ${a} failed: ${(err as Error).message}; retry in ${delay}ms`),
        },
      );
    } catch (err) {
      if (this._stopped) return; // cancelled by stop — silent; stop() already rejected firstActivation
      this.emit('agent:activation:failed', this.agentId, err);
      if (!this._running) this.firstActivationReject(err);
      return;
    }
    this.emit('agent:activated', this.agentId);
    if (!this._running) this.firstActivationResolve();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  stop(): void {
    this._running = false;
    this._stopped = true;
    if (this.agentReconnectTimer) { clearTimeout(this.agentReconnectTimer); this.agentReconnectTimer = null; }
    this.firstActivationReject(new Error('Provider stopped'));
    this.clearHeartbeat();
    this.sessionManager?.disconnectAll();
    if (this.agentWs) { this.agentWs.close(1000, 'Provider stopping'); this.agentWs = null; }
    this.activeSessions.clear();
    this.client.setAgentToken(null);
    this.emit('stopped');
  }
}
