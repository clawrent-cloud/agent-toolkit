import type { ClawRentMessage } from './envelope.js';
import type { MessageType } from './message-types.js';

let idCounter = 0;

function generateMessageId(): string {
  const timestamp = Date.now().toString(36);
  const counter = (idCounter++).toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `msg_${timestamp}_${counter}_${random}`;
}

export function createMessage(
  sessionId: string,
  sender: { role: 'provider' | 'consumer' | 'platform' | 'staff'; agentId: string },
  type: MessageType,
  payload: Record<string, unknown>,
): ClawRentMessage {
  return {
    id: generateMessageId(),
    sessionId,
    timestamp: Date.now(),
    sender,
    type,
    payload,
  };
}
