import { createCorrelationId } from './protocol.js';

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
