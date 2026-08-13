import { createCorrelationId, isResponse, isRequest, type JsonRpcMessage, type ResultPayload } from './protocol.js';
import { StdioBridge } from './stdio-bridge.js';
import {
  ApiClient,
  ConsumerAgentClient,
  FileCursorStore,
  getConfigDir,
  loadConfig,
} from '@clawrent/provider';
import { join } from 'node:path';
import { printError } from '../output.js';
import { evaluateServeRules, type ServeRule, type SessionCtx } from './serve-rules.js';

/** Description of what the daemon should emit on stdout for one inbound WS frame.
 *  `instruction` carries no corrId — the caller generates it (it must track pending
 *  instructions in a Map). null = drop the frame. */
export type ConsumerBridgeOut =
  | { kind: 'dialogue'; params: { sessionId: string; content: string; dialogueType: string } }
  | {
      kind: 'instruction';
      params: {
        sessionId: string;
        messageId: string;
        type: string;
        payload: Record<string, unknown>;
        sender?: unknown;
      };
    }
  | { kind: 'result'; params: { sessionId: string; type: string; payload: Record<string, unknown> } }
  | { kind: 'sessionEnded'; params: { sessionId: string; reason: string } }
  | { kind: 'peerConnected'; params: { sessionId: string } }
  | { kind: 'message'; params: Record<string, unknown> };

/** Map an inbound /ws/group frame to a stdout bridge descriptor. Pure. */
export function routeMessageToNotification(
  sessionId: string,
  message: Record<string, unknown>,
): ConsumerBridgeOut | null {
  const type = (message['type'] as string) ?? '';
  if (type.startsWith('instruction.')) {
    return {
      kind: 'instruction',
      params: {
        sessionId,
        messageId: (message['id'] as string) ?? '',
        type,
        payload: (message['payload'] as Record<string, unknown>) ?? {},
        sender: message['sender'],
      },
    };
  }
  if (type.startsWith('dialogue.')) {
    const payload = (message['payload'] as Record<string, unknown>) ?? {};
    return {
      kind: 'dialogue',
      params: {
        sessionId,
        content: String(payload['content'] ?? ''),
        dialogueType: String(payload['dialogueType'] ?? 'message'),
      },
    };
  }
  if (type.startsWith('result.')) {
    return {
      kind: 'result',
      params: {
        sessionId,
        type,
        payload: (message['payload'] as Record<string, unknown>) ?? {},
      },
    };
  }
  if (type === 'system.session_ended' || type === 'system.peer_disconnected') {
    return { kind: 'sessionEnded', params: { sessionId, reason: type } };
  }
  if (type === 'system.peer_connected') {
    return { kind: 'peerConnected', params: { sessionId } };
  }
  if (type === 'system.heartbeat_ack') return null;
  return { kind: 'message', params: { ...message, sessionId } };
}

/** Discovered sessionIds not already in `current`. Pure. */
export function diffDiscovered(current: Iterable<string>, discovered: Iterable<string>): string[] {
  const have = new Set(current);
  return [...discovered].filter((sid) => !have.has(sid));
}

// Re-exported for C2's runConsumerDaemon (instruction corrId generation).
export { createCorrelationId };

export interface ConsumerDaemonOptions {
  agentToken: string;
  pollInterval: number;
  cursorPath?: string;
  /** Phase 3: serve rules (if omitted, fetched from /me/serve-rules at startup). */
  serveRules?: ServeRule[];
}

const pendingInstructions = new Map<string, string>(); // corrId -> sessionId

export async function runConsumerDaemon(opts: ConsumerDaemonOptions): Promise<void> {
  const config = loadConfig();
  config.token = opts.agentToken;
  const client = new ApiClient(config);
  client.setAgentToken(opts.agentToken);
  const bridge = new StdioBridge();

  // 1. Resolve agent (pins agentId so ConsumerAgentClient.start won't re-fetch)
  let agentId: string;
  let agentName: string;
  let serveHosting = 'self';
  try {
    const agent = await client.getMyAgent();
    agentId = (agent['id'] as string) ?? '';
    agentName = (agent['name'] as string) ?? agentId;
    serveHosting = (agent['serveHosting'] as string) ?? 'self';
  } catch {
    printError('Failed to resolve agent from token. Is the token valid?');
    process.exit(1);
  }

  // Phase 3: platform hosting is reserved for phase 4 — refuse here as a safety net
  // (serve/index.ts also guards before forking the daemon).
  if (serveHosting === 'platform') {
    printError(
      'This agent is platform-hosted (serveHosting=platform). Platform hosting is not implemented until phase 4 — run serve on the consumer host with serveHosting=self.',
    );
    process.exit(1);
  }

  // Load serve rules (phase 3). null/[] = serve all (phase-2-compatible).
  let serveRules: ServeRule[] | null = opts.serveRules ?? null;
  if (opts.serveRules === undefined) {
    try {
      serveRules = (await client.getServeRules()).rules;
    } catch {
      // non-fatal: fall back to serve-all
    }
  }

  const cursorPath = opts.cursorPath ?? join(getConfigDir(), `consumer-cursor-${agentId}.json`);
  const consumer = new ConsumerAgentClient({
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    agentToken: opts.agentToken,
    agentId,
    cursorStore: new FileCursorStore(cursorPath),
  });

  // Runtime overrides (stdin addSession/removeSession) take priority over rules.
  const overrides = new Map<string, 'serve' | 'skip'>();
  // Discovered session contexts (full objects for rule evaluation).
  const discoveredCtx = new Map<string, SessionCtx>();

  const toCtx = (s: Record<string, unknown>): SessionCtx => ({
    sessionId: String(s['sessionId'] ?? ''),
    sessionType: s['sessionType'] as string | undefined,
    peerAgentIds: s['peerAgentIds'] as string[] | undefined,
    peerParticipantTypes: s['peerParticipantTypes'] as string[] | undefined,
    tags: s['tags'] as string[] | undefined,
    taskDescription: s['taskDescription'] as string | undefined,
  });

  const decide = (ctx: SessionCtx): 'serve' | 'skip' => {
    const ov = overrides.get(ctx.sessionId);
    if (ov) return ov;
    return evaluateServeRules(serveRules, ctx);
  };

  // 2. discovery (full session objects, not just ids — rules need the context)
  const discover = async (): Promise<Record<string, unknown>[]> => {
    const res = await client.getMyAgentSessions();
    return res.sessions ?? [];
  };

  // Decide serve/skip for a discovered session and act on it. Idempotent (skips already-known).
  const applyDecision = (session: Record<string, unknown>): void => {
    const ctx = toCtx(session);
    const sid = ctx.sessionId;
    if (!sid || discoveredCtx.has(sid)) return;
    discoveredCtx.set(sid, ctx);
    if (decide(ctx) === 'serve') {
      consumer.addSession(sid);
    } else {
      bridge.writeNotification('session.skipped', { sessionId: sid, reason: 'rule' });
    }
  };

  // 3. inbound: WS frame -> stdout bridge notification (via the pure router from C1)
  const onMessage = (session: { sessionId: string }, message: Record<string, unknown>): void => {
    const out = routeMessageToNotification(session.sessionId, message);
    if (!out) return;
    switch (out.kind) {
      case 'instruction': {
        const corrId = createCorrelationId();
        pendingInstructions.set(corrId, session.sessionId);
        bridge.writeRequest('instruction', corrId, out.params);
        break;
      }
      case 'dialogue':
        bridge.writeNotification('dialogue', out.params);
        break;
      case 'result':
        bridge.writeNotification('result', out.params);
        break;
      case 'sessionEnded':
        bridge.writeNotification('session.ended', out.params);
        break;
      case 'peerConnected':
        bridge.writeNotification('session.peer_connected', out.params);
        break;
      case 'message':
        bridge.writeNotification('message', out.params);
        break;
    }
  };

  // 4. wire ConsumerAgentClient events -> bridge
  consumer.on('session:connected', (sid: string) => bridge.writeNotification('session.connected', { sessionId: sid }));
  consumer.on('session:disconnected', (sid: string, reason: string) =>
    bridge.writeNotification('session.disconnected', { sessionId: sid, reason }),
  );
  consumer.on('session:reconnecting', (sid: string, delay: number) =>
    bridge.writeNotification('session.reconnecting', { sessionId: sid, delay }),
  );
  consumer.on('session:error', (sid: string, err: Error) =>
    bridge.writeNotification('session.error', { sessionId: sid, message: err.message }),
  );

  // Phase 3: control channel (/ws/agent/consumer) — push session.new/ended + connection state
  consumer.on('control:connected', () => bridge.writeNotification('control.connected', { agentId }));
  consumer.on('control:error', () =>
    bridge.writeNotification('control.error', { message: 'control channel error (poll fallback active)' }),
  );
  consumer.on('control:session.new', () => {
    // Push says a new session is visible — re-discover for full ctx + decide (push accelerates
    // past the poll interval). Idempotent: applyDecision skips already-discovered sessions.
    void discover()
      .then((sessions) => sessions.forEach(applyDecision))
      .catch(() => { /* transient; poll loop will retry */ });
  });
  consumer.on('control:session.ended', (payload: Record<string, unknown>) => {
    const sid = (payload['sessionId'] as string | undefined) ?? '';
    if (!sid) return;
    discoveredCtx.delete(sid);
    overrides.delete(sid);
    bridge.writeNotification('session.ended', { sessionId: sid, reason: 'session.ended' });
  });
  consumer.on('control:disconnected', () =>
    bridge.writeNotification('control.disconnected', { reason: 'push channel down; poll fallback active' }),
  );

  // 5. outbound: stdin JSON-RPC -> WS (send / instruction-response / runtime control). No `approve`.
  bridge.start((msg: JsonRpcMessage) => {
    if (isResponse(msg)) {
      const sid = pendingInstructions.get(msg.id);
      if (sid && msg.result) {
        pendingInstructions.delete(msg.id);
        const result = msg.result as unknown as ResultPayload;
        void consumer
          .send(sid, {
            type: result.type ?? 'result.success',
            payload: result.payload ?? result,
          })
          .catch((err: unknown) => {
            // Closed stdout during shutdown would otherwise become an unhandled rejection.
            bridge.writeNotification('session.error', {
              sessionId: sid,
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      return;
    }
    if (isRequest(msg)) {
      const p = (msg.params as Record<string, unknown> | undefined) ?? {};
      const sid = p['sessionId'] as string | undefined;
      if (msg.method === 'send') {
        if (sid) {
          void consumer
            .send(sid, {
              type: (p['type'] as string) ?? 'dialogue.message',
              payload: (p['payload'] as Record<string, unknown>) ?? { content: '' },
            })
            .then((r) => bridge.writeResponse(msg.id, { success: r.delivered }))
            .catch(() => { /* shutdown race */ });
        }
      } else if (msg.method === 'addSession') {
        // Runtime override: force-serve (priority over rules).
        if (sid) {
          overrides.set(sid, 'serve');
          consumer.addSession(sid);
        }
        bridge.writeResponse(msg.id, { ok: true, sessionId: sid });
      } else if (msg.method === 'removeSession') {
        // Runtime override: force-skip. Best-effort: the /ws/group socket is force-closed; the
        // override prevents re-join on the next discover/push cycle (SM reconnect is group-level).
        if (sid) {
          overrides.set(sid, 'skip');
          consumer.forceDisconnect(sid);
        }
        bridge.writeResponse(msg.id, { ok: true, sessionId: sid });
      } else if (msg.method === 'listSessions') {
        bridge.writeResponse(msg.id, {
          discovered: [...discoveredCtx.keys()],
          joined: consumer.activeSessionIds,
          skipped: [...overrides.entries()].filter(([, a]) => a === 'skip').map(([k]) => k),
        });
      }
    }
    // notifications + unknown requests ignored
  });

  // 6. start: connect nothing initially (rules decide), then apply decisions to discovered sessions
  await consumer.start({
    sessionIds: [],
    onMessage,
    onSessionDead: (s) => {
      discoveredCtx.delete(s.sessionId);
      overrides.delete(s.sessionId);
      bridge.writeNotification('session.ended', { sessionId: s.sessionId });
    },
  });

  const initial = await discover().catch((e) => {
    printError(`Initial discovery failed: ${e instanceof Error ? e.message : String(e)}`);
    return [] as Record<string, unknown>[];
  });
  initial.forEach(applyDecision);
  bridge.writeNotification('ready', {
    agentId,
    agentName,
    serveHosting,
    sessionCount: consumer.activeSessionIds.length,
  });

  // 7. poll loop (fallback when control channel is down + rule re-eval for new sessions)
  const pollTimer = setInterval(async () => {
    try {
      const sessions = await discover();
      sessions.forEach(applyDecision);
    } catch {
      // transient discovery failure — retry next tick
    }
  }, opts.pollInterval);

  // 8. graceful shutdown
  const shutdown = (): void => {
    clearInterval(pollTimer);
    try { consumer.stop(); } catch { /* ignore */ }
    bridge.stop();
    bridge.writeNotification('shutdown', { reason: 'signal' });
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
