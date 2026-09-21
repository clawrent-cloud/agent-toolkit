import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { ApiClient } from './api-client.js';
import {
  StaffQueryFrameSchema,
  StaffTaskAckFrameSchema,
  StaffTaskErrorFrameSchema,
  StaffTaskResultFrameSchema,
  StaffOutboundFrameSchema,
  type StaffHelloFrame,
  type StaffInboundFrame,
  type StaffOutboundFrame,
  type StaffTaskPayload,
} from '@clawrent/protocol';

/**
 * StaffAgentClient — persistent client for the platform's /ws/staff channel
 * (Agent Staff delegate side). Mirrors the lifecycle conventions of
 * ConsumerAgentClient's control channel (connect -> heartbeat -> reconnect with
 * exponential backoff) but adds two staff-specific behaviors:
 *
 *  - Terminal close codes: 4012 (invalid staff token) / 4016 (delegation
 *    revoked-or-expired) mean the connection can NEVER be re-established, so
 *    the client stops immediately and isTerminalDead() flips true. Everything
 *    else reconnects with backoff (1s -> 30s, maxReconnectAttempts).
 *  - Request/response queries: query() stamps a self-incrementing queryId,
 *    matches the staff.query_response frame back by id, and rejects after a
 *    60s timeout.
 *
 * Outbound frames are built as complete frame objects and validated with the
 * protocol 0.4.0 schemas (.parse) before JSON.stringify -> ws.send; inbound
 * frames are validated with StaffOutboundFrameSchema.safeParse and ignored
 * (console.warn) when they do not match. Snapshot redelivery after reconnect
 * means tasks are at-least-once: callers should tolerate seeing the same
 * taskId again (late acks/results are rejected server-side as reclaim).
 *
 * Lifecycle: construct -> start({ onTask, onHello? }) -> ackTask/resultTask/
 * errorTask/query ... -> stop().
 */

/** /ws/staff close codes that mean the connection can never be re-established —
 *  give up immediately instead of retrying (isTerminalDead() -> true, pending
 *  queries rejected). Aligned 1:1 with apps/platform-api ws-staff-handler.ts:
 *   - 4000 missing token query param (client bug — retrying cannot fix it)
 *   - 4012 invalid staff token (unknown/expired stf_ token, delegator disabled)
 *   - 4016 delegation revoked-or-expired
 *  4013 is deliberately NOT in this set: it is a /ws/group code ("no active
 *  participant"); the staff handler never emits it — delegation death on
 *  /ws/staff is always 4016. Every other close (1000 server roll, 1006 network
 *  drop, ...) schedules a reconnect: a staff presence channel should survive
 *  server-side closes, so unlike SessionManager we reconnect on 1000 too. */
const STAFF_TERMINAL_CLOSE_CODES = new Set([4000, 4012, 4016]);

export interface StaffAgentClientOptions {
  apiUrl?: string;
  wsUrl?: string;
  staffToken: string;
  /** Idle keepalive frame cadence. Default 25 000ms (matches the other channels). */
  heartbeatIntervalMs?: number;
  /** Reconnect attempts before giving up ('staff:dead'). Default 5. */
  maxReconnectAttempts?: number;
  /** staff.hello wait after connect before start() fails. Default 15 000ms.
   *  (Exposed so tests can exercise the timeout without waiting 15s.) */
  helloTimeoutMs?: number;
  /** staff.query response window. Default 60 000ms. (Test seam, same reason.) */
  queryTimeoutMs?: number;
}

export interface StaffClientHandlers {
  /** Called for every dispatched task — from the connect-time staff.tasks_snapshot
   *  AND from live staff.task frames (and again after reconnect redelivery). */
  onTask: (task: StaffTaskPayload, client: StaffAgentClient) => void | Promise<void>;
  /** Called on the staff.hello greeting (initial connect and every reconnect). */
  onHello?: (hello: StaffHelloFrame) => void;
}

/** Resolved value of query(): the platform answers with data XOR error. */
export interface StaffQueryResult {
  data?: Record<string, unknown>;
  error?: string;
}

interface PendingQuery {
  resolve: (r: StaffQueryResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface HelloWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class StaffAgentClient extends EventEmitter {
  private readonly client: ApiClient;
  private readonly staffToken: string;
  private readonly heartbeatIntervalMs: number;
  private readonly maxReconnectAttempts: number;
  private readonly helloTimeoutMs: number;
  private readonly queryTimeoutMs: number;

  private handlers: StaffClientHandlers | null = null;
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set only while start() is awaiting the initial staff.hello. */
  private helloWaiter: HelloWaiter | null = null;
  private reconnectAttempts = 0;
  private queryCounter = 0;
  private stopped = false;
  private _terminalDead = false;
  private readonly pendingQueries = new Map<string, PendingQuery>();

  constructor(opts: StaffAgentClientOptions) {
    super();
    this.client = new ApiClient({
      apiUrl: opts.apiUrl ?? 'https://clawrent.cloud',
      wsUrl: opts.wsUrl ?? 'wss://clawrent.cloud',
    });
    // Staff REST calls (future task-listing hooks) authenticate via X-Staff-Token.
    this.client.setStaffToken(opts.staffToken);
    this.staffToken = opts.staffToken;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 25_000;
    this.maxReconnectAttempts = opts.maxReconnectAttempts ?? 5;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? 15_000;
    this.queryTimeoutMs = opts.queryTimeoutMs ?? 60_000;
  }

  /** True after a terminal close (4012 invalid token / 4016 delegation dead):
   *  the client stopped for good — reconnecting is pointless until the caller
   *  obtains a fresh token/delegation (construct a new client). */
  isTerminalDead(): boolean {
    return this._terminalDead;
  }

  /** Connect + wait for the staff.hello greeting. Throws after helloTimeoutMs
   *  ('staff hello timeout') or if the connection closes before the greeting —
   *  and shuts the client down (a server that rejects or never greets will not
   *  greet a retry either, so start() fails hard instead of looping in the
   *  background). Tasks carried by the connect-time staff.tasks_snapshot are
   *  re-emitted through onTask after start() resolves. */
  async start(h: StaffClientHandlers): Promise<void> {
    if (this.handlers) throw new Error('StaffAgentClient already started');
    if (this.stopped) throw new Error('StaffAgentClient already stopped (construct a new instance)');
    this.handlers = h;
    this._terminalDead = false;
    await this.connectWithHelloWait();
    this.emit('started');
  }

  /** Acknowledge a dispatched task (staff.task_ack). Dropped with a
   *  'staff:warning' when the connection is not open. */
  ackTask(taskId: string): void {
    this.sendInboundFrame(
      StaffTaskAckFrameSchema.parse({ type: 'staff.task_ack', taskId }),
      `ackTask(${taskId})`,
    );
  }

  /** Deliver a task result — the result IS the proposal (endpoint contract:
   *  proposedAction + reasoning required, no status field; failures go through
   *  errorTask). */
  resultTask(
    taskId: string,
    r: { proposedAction: { targetType: string; targetId: string; params: Record<string, unknown> }; reasoning: string },
  ): void {
    this.sendInboundFrame(
      StaffTaskResultFrameSchema.parse({
        type: 'staff.task_result',
        taskId,
        reasoning: r.reasoning,
        proposedAction: r.proposedAction,
      }),
      `resultTask(${taskId})`,
    );
  }

  /** Report a task failure (staff.task_error). */
  errorTask(taskId: string, message: string): void {
    this.sendInboundFrame(
      StaffTaskErrorFrameSchema.parse({ type: 'staff.task_error', taskId, message }),
      `errorTask(${taskId})`,
    );
  }

  /** Fire a whitelisted read-only staff.query and await its staff.query_response,
   *  matched by a self-incrementing queryId (q-1, q-2, ...). Rejects after
   *  queryTimeoutMs with no response, or immediately when the connection is
   *  not open. */
  query(queryType: string, parameters?: Record<string, unknown>): Promise<StaffQueryResult> {
    const queryId = `q-${++this.queryCounter}`;
    const frame = StaffQueryFrameSchema.parse({
      type: 'staff.query',
      queryId,
      queryType,
      ...(parameters !== undefined ? { parameters } : {}),
    });
    return new Promise<StaffQueryResult>((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error(`query(${queryType}) rejected: staff connection not open`));
        return;
      }
      const pending: PendingQuery = {
        resolve: (r) => { clearTimeout(pending.timer); resolve(r); },
        reject: (err) => { clearTimeout(pending.timer); reject(err); },
        timer: setTimeout(() => {
          // Self-remove so a late response is ignored rather than delivered.
          if (this.pendingQueries.get(queryId) === pending) this.pendingQueries.delete(queryId);
          pending.reject(new Error(`staff query ${queryId} (${queryType}) timed out after ${this.queryTimeoutMs}ms`));
        }, this.queryTimeoutMs),
      };
      this.pendingQueries.set(queryId, pending);
      ws.send(JSON.stringify(frame));
    });
  }

  /** Stop the client: close the socket, cancel heartbeat/reconnect/hello timers,
   *  reject pending queries. Idempotent — second and later calls are no-ops. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.clearTimers();
    this.clearHelloWaiter();
    this.rejectAllPendingQueries(new Error('staff client stopped'));
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    this.handlers = null;
    this.emit('stopped');
  }

  // ── internals ──────────────────────────────────────────────────────────

  /** Open the socket and arm the hello wait (start() awaits its rejection or
   *  the staff.hello frame, whichever comes first). */
  private connectWithHelloWait(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(this.buildUrl());
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;
      const waiter: HelloWaiter = {
        resolve: () => { clearTimeout(waiter.timer); resolve(); },
        reject: (err) => { clearTimeout(waiter.timer); reject(err); },
        timer: setTimeout(() => {
          if (this.helloWaiter !== waiter || this.stopped) return;
          this.helloWaiter = null;
          waiter.reject(new Error('staff hello timeout'));
          this.stop(); // fail hard: no background reconnect loop once start() failed
        }, this.helloTimeoutMs),
      };
      this.helloWaiter = waiter;
      this.bindWs(ws);
    });
  }

  /** Reconnect path: no start() promise is pending; a missing greeting just
   *  force-closes the socket so the close handler schedules the next attempt. */
  private reconnect(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.buildUrl());
    } catch (err) {
      this.emit('staff:error', err);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    const timer = setTimeout(() => {
      if (this.ws === ws) {
        try { ws.close(); } catch { /* ignore */ }
      }
    }, this.helloTimeoutMs);
    ws.once('close', () => clearTimeout(timer));
    this.bindWs(ws);
  }

  private buildUrl(): string {
    return `${this.client.wsUrl}/ws/staff?token=${encodeURIComponent(this.staffToken)}`;
  }

  /** Attach the shared open/message/close/error handlers (used by both the
   *  initial and reconnect connections). */
  private bindWs(ws: WebSocket): void {
    ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.heartbeatTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          // Raw keepalive frame (like the consumer control channel). Not part of
          // the staff frame contract — the backend default-case ignores it; the
          // point is keeping NAT/proxy mappings warm.
          try { this.ws.send(JSON.stringify({ type: 'system.heartbeat' })); } catch { /* ignore */ }
        }
      }, this.heartbeatIntervalMs);
      this.emit('staff:connected');
    });

    ws.on('message', (raw) => {
      let json: unknown;
      try {
        json = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed JSON
      }
      const parsed = StaffOutboundFrameSchema.safeParse(json);
      if (!parsed.success) {
        console.warn('[StaffAgentClient] ignoring invalid inbound frame:', parsed.error.issues[0]?.message ?? 'schema mismatch');
        return;
      }
      this.handleFrame(parsed.data as StaffOutboundFrame);
    });

    ws.on('close', (code, reason) => {
      this.clearTimers();
      if (this.ws === ws) this.ws = null;
      const why = reason.toString();
      this.emit('staff:disconnected', code, why);
      if (this.stopped) return;

      // Initial connection closed before the greeting — fail start() hard and
      // shut down. A terminal code here (backend rejects a bad token/delegation
      // WITHOUT ever greeting) must still mark the client terminal-dead.
      if (this.helloWaiter) {
        const waiter = this.helloWaiter;
        this.helloWaiter = null;
        if (STAFF_TERMINAL_CLOSE_CODES.has(code)) {
          this._terminalDead = true;
          this.rejectAllPendingQueries(new Error(`staff connection closed (terminal close ${code})`));
          waiter.reject(new Error(`staff connection rejected before hello (code ${code}: ${why})`));
          this.emit('staff:dead', code, why);
        } else {
          waiter.reject(new Error(`staff connection closed before hello (code ${code}: ${why})`));
        }
        this.stop();
        return;
      }

      if (STAFF_TERMINAL_CLOSE_CODES.has(code)) {
        // 4012/4016: the token/delegation is dead — retrying only earns the
        // same close. Mark terminal, fail waiters, stop the loop.
        this._terminalDead = true;
        this.rejectAllPendingQueries(new Error(`staff connection closed (terminal close ${code})`));
        this.emit('staff:dead', code, why);
        return;
      }

      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.rejectAllPendingQueries(new Error('staff client gave up reconnecting'));
        this.emit('staff:dead', code, `max reconnect attempts (${this.maxReconnectAttempts}) reached`);
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
      this.reconnectAttempts++;
      this.emit('staff:reconnecting', delay);
      this.scheduleReconnect(delay);
    });

    ws.on('error', (err) => {
      this.emit('staff:error', err);
      // 'close' follows and drives reconnect/terminal handling.
    });
  }

  private handleFrame(frame: StaffOutboundFrame): void {
    switch (frame.type) {
      case 'staff.hello': {
        // Greeting arrived: release start() (no-op when this is a reconnect).
        if (this.helloWaiter) {
          const waiter = this.helloWaiter;
          this.helloWaiter = null;
          waiter.resolve();
        }
        this.handlers?.onHello?.(frame);
        this.emit('staff:hello', frame);
        return;
      }
      case 'staff.tasks_snapshot': {
        for (const task of frame.tasks) this.dispatchTask(task);
        return;
      }
      case 'staff.task': {
        this.dispatchTask(frame.task);
        return;
      }
      case 'staff.query_response': {
        const pending = this.pendingQueries.get(frame.queryId);
        if (!pending) {
          // Late response (query already timed out) or unknown id — ignore.
          console.warn(`[StaffAgentClient] query_response for unknown queryId ${frame.queryId} ignored`);
          return;
        }
        this.pendingQueries.delete(frame.queryId);
        pending.resolve({ data: frame.data, error: frame.error });
        return;
      }
    }
  }

  /** Surface a task to onTask; a throwing handler must never take the
   *  connection down (at-least-once redelivery retries it later). */
  private dispatchTask(task: StaffTaskPayload): void {
    const cb = this.handlers?.onTask;
    if (!cb) return;
    try {
      const r = cb(task, this);
      if (r instanceof Promise) {
        r.catch((err) => { this.emit('staff:error', err, task); });
      }
    } catch (err) {
      this.emit('staff:error', err, task);
    }
  }

  /** Validate-then-send one staff->platform frame (the protocol names frames
   *  from the platform's perspective, so our outbound union is the inbound one).
   *  Dropped with 'staff:warning' when the socket is not open. */
  private sendInboundFrame(frame: StaffInboundFrame, what: string): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const msg = `${what} dropped: staff connection not open`;
      console.warn(`[StaffAgentClient] ${msg}`);
      this.emit('staff:warning', msg);
      return;
    }
    ws.send(JSON.stringify(frame));
  }

  private scheduleReconnect(delay?: number): void {
    if (this.stopped || this._terminalDead) return;
    if (this.reconnectTimer) return; // already scheduled
    const wait = delay ?? Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && !this._terminalDead) this.reconnect();
    }, wait);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private clearHelloWaiter(): void {
    if (this.helloWaiter) {
      clearTimeout(this.helloWaiter.timer);
      this.helloWaiter = null;
    }
  }

  private rejectAllPendingQueries(err: Error): void {
    for (const pending of this.pendingQueries.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingQueries.clear();
  }
}
