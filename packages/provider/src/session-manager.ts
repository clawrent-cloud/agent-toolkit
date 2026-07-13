import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/** Backend close codes that mean the session can never be (re)attached —
 * stop immediately instead of retrying. Aligned with apps/platform-api ws-handler
 * (4000 bad params, 4001 bad role, 4002 token mismatch, 4003 session not active,
 * 4004 slot missing). 4005 was removed; 4006 (concurrency) is transient. */
const TERMINAL_CLOSE_CODES = new Set([4000, 4001, 4002, 4003, 4004]);

export interface SessionConnection {
  sessionId: string;
  sessionToken: string;
  ws: WebSocket;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
  reconnectAttempts: number;
}

/**
 * SessionManager manages multiple concurrent WebSocket connections,
 * one per active session.
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, SessionConnection>();
  private wsUrl: string;
  private heartbeatInterval: number;
  private maxReconnectDelay: number;
  private maxReconnectAttempts: number;
  public agentId?: string;

  constructor(
    wsUrl: string,
    heartbeatInterval = 25_000,
    maxReconnectDelay = 30_000,
    maxReconnectAttempts = 5,
  ) {
    super();
    this.wsUrl = wsUrl;
    this.heartbeatInterval = heartbeatInterval;
    this.maxReconnectDelay = maxReconnectDelay;
    this.maxReconnectAttempts = maxReconnectAttempts;
  }

  /** Connect to a session via WebSocket as provider */
  connect(sessionId: string, sessionToken: string): void {
    if (this.sessions.has(sessionId)) {
      return; // Already connected
    }

    const url = `${this.wsUrl}/ws/session?sessionId=${sessionId}&token=${sessionToken}&role=provider`;
    const ws = new WebSocket(url);

    const conn: SessionConnection = {
      sessionId,
      sessionToken,
      ws,
      heartbeatTimer: null,
      reconnectAttempts: 0,
    };

    this.sessions.set(sessionId, conn);

    ws.on('open', () => {
      conn.reconnectAttempts = 0;
      conn.heartbeatTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'system.heartbeat', payload: {} }));
        }
      }, this.heartbeatInterval);

      this.emit('session:connected', sessionId);
    });

    ws.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as Record<string, unknown>;
        // Skip heartbeat acks
        if (message['type'] === 'system.heartbeat_ack') return;

        this.emit('session:message', sessionId, message);
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', (code, reason) => {
      this.clearHeartbeat(conn);

      // Terminal codes (bad params / auth / session state) — never retry,
      // otherwise a stale sessionToken causes infinite reconnect noise.
      if (TERMINAL_CLOSE_CODES.has(code)) {
        this.sessions.delete(sessionId);
        this.emit('session:dead', sessionId, `session rejected (code ${code}: ${reason.toString()})`);
        return;
      }

      if (code !== 1000) {
        // Abnormal close — retry up to maxReconnectAttempts, then give up.
        if (conn.reconnectAttempts >= this.maxReconnectAttempts) {
          this.sessions.delete(sessionId);
          this.emit('session:dead', sessionId, `max reconnect attempts (${this.maxReconnectAttempts}) reached`);
          return;
        }
        const delay = Math.min(
          1000 * Math.pow(2, conn.reconnectAttempts),
          this.maxReconnectDelay,
        );
        conn.reconnectAttempts++;

        this.emit('session:reconnecting', sessionId, delay);

        setTimeout(() => {
          this.sessions.delete(sessionId);
          this.connect(sessionId, sessionToken);
        }, delay);
      } else {
        this.sessions.delete(sessionId);
        this.emit('session:disconnected', sessionId, reason.toString());
      }
    });

    ws.on('error', (err) => {
      this.emit('session:error', sessionId, err);
    });
  }

  /** Send a message to a specific session, auto-wrapping with protocol envelope */
  send(sessionId: string, message: Record<string, unknown>): boolean {
    const conn = this.sessions.get(sessionId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    // Ensure full ClawRentMessage envelope
    const envelope = {
      id: message['id'] ?? `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      sessionId: message['sessionId'] ?? sessionId,
      timestamp: message['timestamp'] ?? Date.now(),
      sender: message['sender'] ?? { role: 'provider', agentId: this.agentId ?? 'unknown' },
      type: message['type'] ?? 'result.success',
      payload: message['payload'] ?? {},
    };
    conn.ws.send(JSON.stringify(envelope));
    return true;
  }

  /** Disconnect a specific session */
  disconnect(sessionId: string): void {
    const conn = this.sessions.get(sessionId);
    if (!conn) return;

    this.clearHeartbeat(conn);
    if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
      conn.ws.close(1000, 'Provider disconnecting');
    }
    this.sessions.delete(sessionId);
  }

  /** Disconnect all sessions */
  disconnectAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.disconnect(sessionId);
    }
  }

  /** Get active session count */
  get activeCount(): number {
    return this.sessions.size;
  }

  /** Check if a session is connected */
  isConnected(sessionId: string): boolean {
    const conn = this.sessions.get(sessionId);
    return conn?.ws.readyState === WebSocket.OPEN;
  }

  private clearHeartbeat(conn: SessionConnection): void {
    if (conn.heartbeatTimer) {
      clearInterval(conn.heartbeatTimer);
      conn.heartbeatTimer = null;
    }
  }
}
