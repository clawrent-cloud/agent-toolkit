import { ClawRentMessageSchema, type ClawRentMessage } from './envelope.js';

export function validateMessage(raw: unknown): ClawRentMessage {
  return ClawRentMessageSchema.parse(raw);
}
