import { z } from 'zod';
import { MessageType } from './message-types.js';

const allMessageTypes = Object.values(MessageType);

export const SenderSchema = z.object({
  role: z.enum(['provider', 'consumer', 'platform', 'staff']),
  agentId: z.string(),
});

export const ClawRentMessageSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  timestamp: z.number(),
  sender: SenderSchema,
  type: z.enum(allMessageTypes as [string, ...string[]]),
  payload: z.record(z.unknown()),
  signature: z.string().optional(),
});

export type ClawRentMessage = z.infer<typeof ClawRentMessageSchema>;
