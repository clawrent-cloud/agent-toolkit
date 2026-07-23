import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

/** Backend close codes that mean the session can never be (re)attached —
 * stop immediately instead of retrying. Aligned with apps/platform-api ws-handler
 * (4000 bad params, 4001 bad role, 4002 token mismatch, 4003 session not active,
 * 4004 slot missing). 4005 was removed; 4006 (concurrency) is transient. */
const TERMINAL_CLOSE_CODES = new Set([4000, 4001, 4002, 4003, 4004]);

/** Backend /ws/group close codes that mean the participant can never (re)attach.
 * Aligned with apps/platform-api ws-group-handler.ts:
 *  4000 missing query params, 4011 invalid/expired JWT, 4012 invalid agent token,
 *  4013 no active participant for this identity, 4014 session not found,
 *  4015 session not active. 4009 (replaced by a newer connection) is NOT terminal
 *  — it is a normal "reconnect" signal handled by the non-terminal retry path. */
const GROUP_TERMINAL_CLOSE_CODES = new Set([4000, 4011, 4012, 4013, 4014, 4015]);

export interface SessionConnection {
  sessionId: string;
  /** /ws/session: the session token. /ws/group: empty (auth is by agentToken). */
  sessionToken: string;
  /** /ws/group only: participantId assigned by the server in the system.connected
   *  handshake. Cached so outbound envelopes can stamp sender.participantId. */
  participantId?: string;
  /** Channel mode. Defaults to 'session' for backward compatibility. */
  mode: 'session' | 'group';
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
      mode: 'session',
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

  /** Connect to a group session via /ws/group as a provider-agent participant.
   *
   * Auth is by agentToken (NOT sessionToken): the backend resolves the agent,
   * finds its active participant row, and pushes a `system.connected` handshake
   * carrying the assigned participantId — which we cache on the conn so outbound
   * envelopes can stamp `sender.participantId`. Presence/ack frames are surfaced
   * via `session:presence` (they do NOT trigger onMessage); `system.connected`
   * via `session:participant`; everything else via `session:message`. */
  connectGroup(sessionId: string, agentToken: string): void {
    if (this.sessions.has(sessionId)) {
      return; // Already connected
    }

    const url = `${this.wsUrl}/ws/group?sessionId=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(agentToken)}`;
    const ws = new WebSocket(url);

    const conn: SessionConnection = {
      sessionId,
      sessionToken: '',
      mode: 'group',
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
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return; // Ignore parse errors
      }
      const type = frame['type'];

      // Handshake: cache the server-assigned participantId.
      if (type === 'system.connected') {
        const participant = (frame['payload'] as { participant?: Record<string, unknown> } | undefined)?.participant;
        const pid = participant?.['participantId'];
        if (typeof pid === 'string') {
          conn.participantId = pid;
          this.emit('session:participant', sessionId, participant);
        }
        return;
      }

      // Presence + ack frames: surface but do NOT trigger onMessage (no cursor
      // advance, no host callback). system.blocked = gateway rejected the frame.
      if (
        type === 'system.participant_joined' ||
        type === 'system.participant_left' ||
        type === 'system.message_ack' ||
        type === 'system.blocked'
      ) {
        this.emit('session:presence', sessionId, frame);
        return;
      }

      // Heartbeat frames are client→server; group mode gets no ack. Defensive
      // skip in case the server ever pushes one back.
      if (type === 'system.heartbeat' || type === 'system.heartbeat_ack') return;

      this.emit('session:message', sessionId, frame);
    });

    ws.on('close', (code, reason) => {
      this.handleGroupClose(sessionId, conn, code, reason, agentToken);
    });

    ws.on('error', (err) => {
      this.emit('session:error', sessionId, err);
    });
  }

  /** /ws/group close handler — mirrors connect()'s close logic but uses the
   *  group terminal-code set and reconnects via connectGroup (agentToken). */
  private handleGroupClose(
    sessionId: string,
    conn: SessionConnection,
    code: number,
    reason: { toString(): string },
    agentToken: string,
  ): void {
    this.clearHeartbeat(conn);

    // Terminal codes (bad params / auth / participant / session state) — never retry.
    if (GROUP_TERMINAL_CLOSE_CODES.has(code)) {
      this.sessions.delete(sessionId);
      this.emit('session:dead', sessionId, `group session rejected (code ${code}: ${reason.toString()})`);
      return;
    }

    if (code !== 1000) {
      // Abnormal close (incl. 4009 replaced-by-newer) — retry up to maxReconnectAttempts.
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
        this.connectGroup(sessionId, agentToken);
      }, delay);
    } else {
      this.sessions.delete(sessionId);
      this.emit('session:disconnected', sessionId, reason.toString());
    }
  }

  /** Send a message to a specific session, auto-wrapping with protocol envelope */
  send(sessionId: string, message: Record<string, unknown>): boolean {
    const conn = this.sessions.get(sessionId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    // Ensure full ClawRentMessage envelope.
    // - group mode: participant-scoped sender ({participantId, side, agentId}) +
    //   optional top-level mentions (server validates against active participants).
    // - session mode: legacy role-scoped sender ({role, agentId}).
    const envelope =
      conn.mode === 'group'
        ? {
            id: message['id'] ?? `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
            sessionId: message['sessionId'] ?? sessionId,
            timestamp: message['timestamp'] ?? Date.now(),
            sender: message['sender'] ?? {
              participantId: conn.participantId,
              side: 'provider',
              agentId: this.agentId ?? 'unknown',
            },
            type: message['type'] ?? 'dialogue.message',
            payload: message['payload'] ?? {},
            ...(Array.isArray(message['mentions']) ? { mentions: message['mentions'] } : {}),
          }
        : {
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
