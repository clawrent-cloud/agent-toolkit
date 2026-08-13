import { describe, it, expect } from 'vitest';
import { routeMessageToNotification, diffDiscovered } from './consumer.js';

describe('routeMessageToNotification', () => {
  it('routes dialogue.* to a dialogue notification', () => {
    const out = routeMessageToNotification('s1', {
      type: 'dialogue.message',
      payload: { content: 'hi', dialogueType: 'message' },
    });
    expect(out).toEqual({
      kind: 'dialogue',
      params: { sessionId: 's1', content: 'hi', dialogueType: 'message' },
    });
  });

  it('routes instruction.* to an instruction descriptor', () => {
    const out = routeMessageToNotification('s1', {
      type: 'instruction.run',
      id: 'm9',
      payload: { foo: 1 },
      sender: { side: 'consumer' },
    });
    expect(out?.kind).toBe('instruction');
    if (out?.kind === 'instruction') {
      expect(out.params).toEqual({
        sessionId: 's1',
        messageId: 'm9',
        type: 'instruction.run',
        payload: { foo: 1 },
        sender: { side: 'consumer' },
      });
    }
  });

  it('routes result.* to a result notification', () => {
    const out = routeMessageToNotification('s1', { type: 'result.success', payload: { x: 1 } });
    expect(out).toEqual({ kind: 'result', params: { sessionId: 's1', type: 'result.success', payload: { x: 1 } } });
  });

  it('routes session_ended / peer_disconnected to sessionEnded', () => {
    const out = routeMessageToNotification('s1', { type: 'system.session_ended' });
    expect(out).toEqual({ kind: 'sessionEnded', params: { sessionId: 's1', reason: 'system.session_ended' } });
  });

  it('routes peer_connected to peerConnected', () => {
    const out = routeMessageToNotification('s1', { type: 'system.peer_connected' });
    expect(out).toEqual({ kind: 'peerConnected', params: { sessionId: 's1' } });
  });

  it('drops heartbeat_ack (returns null)', () => {
    expect(routeMessageToNotification('s1', { type: 'system.heartbeat_ack' })).toBeNull();
  });

  it('passes through unknown types as a message notification', () => {
    const out = routeMessageToNotification('s1', { type: 'system.roster', payload: { x: 1 } });
    expect(out?.kind).toBe('message');
  });
});

describe('diffDiscovered', () => {
  it('returns discovered sessionIds not already in current', () => {
    expect(diffDiscovered(['a', 'b'], ['b', 'c', 'd'])).toEqual(['c', 'd']);
  });
  it('returns empty when all discovered are already current', () => {
    expect(diffDiscovered(['a', 'b'], ['a', 'b'])).toEqual([]);
  });
});
