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
  return { kind: 'message', params: { sessionId, ...message } };
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
  try {
    const agent = await client.getMyAgent();
    agentId = (agent['id'] as string) ?? '';
    agentName = (agent['name'] as string) ?? agentId;
  } catch {
    printError('Failed to resolve agent from token. Is the token valid?');
    process.exit(1);
  }

  const cursorPath = opts.cursorPath ?? join(getConfigDir(), `consumer-cursor-${agentId}.json`);
  const consumer = new ConsumerAgentClient({
    apiUrl: config.apiUrl,
    wsUrl: config.wsUrl,
    agentToken: opts.agentToken,
    agentId,
    cursorStore: new FileCursorStore(cursorPath),
  });

  // 2. discovery helper
  const discover = async (): Promise<string[]> => {
    const res = await client.getMyAgentSessions();
    return (res.sessions ?? []).map((s) => s.sessionId);
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

  // 5. outbound: stdin JSON-RPC -> WS (send / instruction-response). No `approve`.
  bridge.start((msg: JsonRpcMessage) => {
    if (isResponse(msg)) {
      const sid = pendingInstructions.get(msg.id);
      if (sid && msg.result) {
        pendingInstructions.delete(msg.id);
        const result = msg.result as unknown as ResultPayload;
        void consumer.send(sid, {
          type: result.type ?? 'result.success',
          payload: result.payload ?? result,
        });
      }
    } else if (isRequest(msg) && msg.method === 'send') {
      const p = (msg.params as Record<string, unknown> | undefined) ?? {};
      const sid = p['sessionId'] as string | undefined;
      if (sid) {
        void consumer
          .send(sid, {
            type: (p['type'] as string) ?? 'dialogue.message',
            payload: (p['payload'] as Record<string, unknown>) ?? { content: '' },
          })
          .then((r) => bridge.writeResponse(msg.id, { success: r.delivered }));
      }
    }
    // notifications + unknown requests ignored
  });

  // 6. start: discover + connect initial, then poll for new sessions
  const initial = await discover().catch((e) => {
    printError(`Initial discovery failed: ${e instanceof Error ? e.message : String(e)}`);
    return [] as string[];
  });
  await consumer.start({
    sessionIds: initial,
    onMessage,
    onSessionDead: (s) => bridge.writeNotification('session.ended', { sessionId: s.sessionId }),
  });
  bridge.writeNotification('ready', { agentId, agentName, sessionCount: initial.length });

  const pollTimer = setInterval(async () => {
    try {
      const discovered = await discover();
      for (const sid of diffDiscovered(consumer.activeSessionIds, discovered)) {
        consumer.addSession(sid);
      }
    } catch {
      // transient discovery failure — retry next tick
    }
  }, opts.pollInterval);

  // 7. graceful shutdown
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
