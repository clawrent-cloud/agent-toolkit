import { z } from 'zod';

/**
 * /ws/session peer message frame — the forwardPayload pushed by the platform
 * when a consumer or provider sends a dialogue/instruction/result message.
 * Mirrors apps/platform-api/src/ws/ws-handler.ts (forwardPayload, ~L403-416):
 *   { id, sessionId, timestamp, sender:{role,agentId,slotIndex?}, type, payload, _meta }
 * `sender.agentId` is always present backend-side (agentId ?? userId).
 */
export const wsSessionMessageEventSchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  timestamp: z.number(),
  sender: z.object({
    role: z.enum(['provider', 'consumer', 'platform', 'staff']),
    agentId: z.string(),
    slotIndex: z.number().int().min(0).optional(),
  }),
  type: z.string(),
  payload: z.record(z.unknown()),
  _meta: z
    .object({
      sessionId: z.string(),
      senderRole: z.string(),
      slotIndex: z.number().int().min(0).optional(),
      timestamp: z.string(),
    })
    .passthrough(),
});
export type WsSessionMessageEvent = z.infer<typeof wsSessionMessageEventSchema>;

/**
 * /ws/session system.* events. Types confirmed in backend:
 * peer_connected/peer_disconnected (ws-handler.ts), peer_offline (ws-handler.ts),
 * blocked (ws-handler.ts security gateway), error (ws-agent-handler.ts / ws-handler.ts),
 * session_ended (client-manager.ts closeSessionClients — carries `reason`).
 */
export const wsSystemEventSchema = z.object({
  type: z.enum([
    'system.peer_connected',
    'system.peer_disconnected',
    'system.peer_offline',
    'system.blocked',
    'system.error',
    'system.session_ended',
  ]),
  sessionId: z.string().optional(),
  payload: z.record(z.unknown()).optional(),
});
export type WsSystemEvent = z.infer<typeof wsSystemEventSchema>;

/**
 * /ws/agent control channel events delivered via `sendToAgent(agentId, {type, payload})`.
 * Discriminator is `type` (not `event`) and fields live under `payload` — confirmed at
 * sessions.routes.ts:201-212 / 572-580 and orders.routes.ts:229-237.
 *
 * Note: backend does NOT push `session.ended` on /ws/agent. Session terminations arrive
 * as `system.session_ended` on /ws/session (see wsSystemEventSchema).
 */
export const guardrailDecisionSchema = z.object({
  verdict: z.enum(['allow', 'block', 'advisory']),
  categories: z.array(z.string()),
  reason: z.string(),
});
export type GuardrailDecision = z.infer<typeof guardrailDecisionSchema>;

export const wsAgentControlEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session.new'),
    payload: z.object({
      sessionId: z.string(),
      sessionToken: z.string().optional(),
      status: z.string().optional(),
      consumerUserId: z.string().optional(),
      taskDescription: z.string().optional(),
      pricingSnapshot: z.unknown().optional(),
      orderId: z.string().optional(),
      guardrailDecision: guardrailDecisionSchema.optional(),
      timestamp: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('session.approved'),
    payload: z.object({
      sessionId: z.string(),
      sessionToken: z.string().optional(),
      status: z.string().optional(),
      timestamp: z.string().optional(),
    }),
  }),
]);
export type WsAgentControlEvent = z.infer<typeof wsAgentControlEventSchema>;
