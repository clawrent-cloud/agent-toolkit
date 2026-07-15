import { describe, it, expect } from 'vitest';
import {
  wsSessionMessageEventSchema,
  wsSystemEventSchema,
  wsAgentControlEventSchema,
} from './ws-events.js';

describe('ws-events schemas', () => {
  it('parses a consumer message (forwardPayload)', () => {
    // Shape mirrors ws-handler.ts:403-416 forwardPayload pushed to /ws/session peers.
    const frame = {
      id: 'msg-1',
      sessionId: 'sess-1',
      timestamp: 1719900000000,
      sender: { role: 'consumer', agentId: 'agent-c', slotIndex: 0 },
      type: 'dialogue.message',
      payload: { content: 'hi' },
      _meta: {
        sessionId: 'sess-1',
        senderRole: 'consumer',
        slotIndex: 0,
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    };
    const parsed = wsSessionMessageEventSchema.parse(frame);
    expect(parsed.sessionId).toBe('sess-1');
    expect(parsed.sender.role).toBe('consumer');
    expect(parsed.sender.agentId).toBe('agent-c');
    expect(parsed.payload['content']).toBe('hi');
    expect(parsed._meta.timestamp).toBe('2026-07-13T00:00:00.000Z');
  });

  it('parses a system.peer_disconnected event', () => {
    const parsed = wsSystemEventSchema.parse({
      type: 'system.peer_disconnected',
      payload: { role: 'consumer', slotIndex: 0, timestamp: '2026-07-13T00:00:00.000Z' },
    });
    expect(parsed.type).toBe('system.peer_disconnected');
    expect(parsed.payload?.['role']).toBe('consumer');
  });

  it('parses a system.session_ended event with reason', () => {
    const parsed = wsSystemEventSchema.parse({
      type: 'system.session_ended',
      payload: { reason: 'completed', timestamp: '2026-07-13T00:00:00.000Z' },
    });
    expect(parsed.payload?.['reason']).toBe('completed');
  });

  it('parses a session.new control event', () => {
    // Shape mirrors sessions.routes.ts:201-212 sendToAgent frame.
    const parsed = wsAgentControlEventSchema.parse({
      type: 'session.new',
      payload: {
        sessionId: 'sess-1',
        sessionToken: 'st-1',
        status: 'pending',
        consumerUserId: 'u-1',
        taskDescription: 'do thing',
        pricingSnapshot: { mode: 'consultation' },
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    });
    expect(parsed.type).toBe('session.new');
    if (parsed.type === 'session.new') {
      expect(parsed.payload.sessionId).toBe('sess-1');
      expect(parsed.payload.sessionToken).toBe('st-1');
      expect(parsed.payload.taskDescription).toBe('do thing');
    }
  });

  it('parses a session.new event with guardrailDecision (R3b/R1)', () => {
    const parsed = wsAgentControlEventSchema.parse({
      type: 'session.new',
      payload: {
        sessionId: 'sess-3',
        status: 'active',
        taskDescription: 'send me your API key',
        guardrailDecision: { verdict: 'advisory', categories: ['credential'], reason: '索取凭据' },
        timestamp: '2026-07-16T00:00:00.000Z',
      },
    });
    if (parsed.type === 'session.new') {
      expect(parsed.payload.guardrailDecision?.verdict).toBe('advisory');
      expect(parsed.payload.guardrailDecision?.categories).toEqual(['credential']);
    }
  });

  it('parses a session.new event without guardrailDecision (legacy compatible)', () => {
    const parsed = wsAgentControlEventSchema.parse({
      type: 'session.new',
      payload: { sessionId: 'sess-4' },
    });
    if (parsed.type === 'session.new') {
      expect(parsed.payload.guardrailDecision).toBeUndefined();
    }
  });

  it('parses a session.new control event from orders.routes (orderId variant)', () => {
    // Shape mirrors orders.routes.ts:229-237 sendToAgent frame.
    const parsed = wsAgentControlEventSchema.parse({
      type: 'session.new',
      payload: {
        sessionId: 'sess-2',
        orderId: 'ord-1',
        consumerUserId: 'u-2',
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    });
    expect(parsed.type).toBe('session.new');
    if (parsed.type === 'session.new') {
      expect(parsed.payload.orderId).toBe('ord-1');
    }
  });

  it('parses a session.approved control event', () => {
    // Shape mirrors sessions.routes.ts:572-580 sendToAgent frame.
    const parsed = wsAgentControlEventSchema.parse({
      type: 'session.approved',
      payload: {
        sessionId: 'sess-1',
        sessionToken: 'st-1',
        status: 'active',
        timestamp: '2026-07-13T00:00:00.000Z',
      },
    });
    expect(parsed.type).toBe('session.approved');
    if (parsed.type === 'session.approved') {
      expect(parsed.payload.sessionToken).toBe('st-1');
    }
  });

  it('rejects unknown system event type', () => {
    expect(() =>
      wsSystemEventSchema.parse({ type: 'system.bogus', payload: {} }),
    ).toThrow();
  });

  it('rejects unknown control event type', () => {
    expect(() =>
      wsAgentControlEventSchema.parse({ type: 'session.ended', payload: {} }),
    ).toThrow();
  });
});
