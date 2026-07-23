import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { SessionManager } from './session-manager.js';

/** Resolve on the next emission of `event` from `sm`, or reject after `ms`
 *  so a missing emission fails the test loudly instead of hanging. */
function waitFor<T = unknown>(sm: SessionManager, event: string, ms = 1000): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), ms);
    sm.once(event, (...args: unknown[]) => {
      clearTimeout(t);
      resolve(args as T[]);
    });
  });
}

/**
 * Minimal mock of apps/platform-api ws-group-handler: on a /ws/group connection
 * it pushes the `system.connected` handshake (carrying the assigned participantId)
 * and, if `terminalCode` is set, closes with that code. Captures inbound frames so
 * tests can assert the client's outbound envelope.
 */
function mockGroupServer(
  wss: WebSocketServer,
  opts: {
    participantId?: string;
    terminalCode?: number;
    extraFrames?: Record<string, unknown>[];
    onClientMessage?: (frame: Record<string, unknown>) => void;
  } = {},
): void {
  const participantId = opts.participantId ?? 'part-provider-1';
  wss.on('connection', (sock, req) => {
    // Verify the client targeted /ws/group with sessionId + token.
    expect(req.url ?? '').toContain('/ws/group');
    expect(req.url ?? '').toContain('sessionId=sess-g1');
    expect(req.url ?? '').toContain('token=agt_test');

    sock.send(
      JSON.stringify({
        type: 'system.connected',
        payload: {
          participant: {
            participantId,
            participantType: 'agent',
            side: 'provider',
            userId: null,
            agentId: 'agent-1',
            role: 'provider',
          },
        },
      }),
    );

    for (const f of opts.extraFrames ?? []) sock.send(JSON.stringify(f));

    if (opts.terminalCode !== undefined) {
      // Defer so the client receives the handshake first.
      setTimeout(() => { try { sock.close(opts.terminalCode, 'rejected'); } catch { /* closed */ } }, 10);
    }

    sock.on('message', raw => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      opts.onClientMessage?.(msg);
    });
  });
}

describe('SessionManager /ws/group mode', () => {
  let wss: WebSocketServer;
  let port: number;
  let sm: SessionManager;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as AddressInfo).port;
    sm = new SessionManager(`ws://localhost:${port}`, 25_000, 1_000, 5);
    sm.agentId = 'agent-1';
  });
  afterEach(() => {
    sm.disconnectAll();
    wss.close();
  });

  it('connects /ws/group, caches participantId from system.connected, emits session:participant', async () => {
    // Register persistent listeners BEFORE connectGroup so the fast
    // open→handshake sequence can't race past a late `once` registration.
    const events: string[] = [];
    let participantFrame: { participantId: string } | undefined;
    sm.on('session:connected', () => events.push('connected'));
    sm.on('session:participant', (_sid: string, p: { participantId: string }) => {
      events.push('participant');
      participantFrame = p;
    });

    mockGroupServer(wss, { participantId: 'part-xyz' });
    sm.connectGroup('sess-g1', 'agt_test');
    await waitFor(sm, 'session:participant'); // registered above; resolves on the real handshake

    expect(events).toEqual(['connected', 'participant']); // connected fires before participant
    expect(participantFrame?.participantId).toBe('part-xyz');

    // Cached on the conn so send() can stamp sender.participantId.
    const conn = (sm as unknown as { sessions: Map<string, { participantId?: string }> }).sessions.get('sess-g1');
    expect(conn?.participantId).toBe('part-xyz');
  });

  it('is idempotent: a second connectGroup for the same session is a no-op', async () => {
    let connections = 0;
    wss.on('connection', () => connections++);
    mockGroupServer(wss);

    sm.connectGroup('sess-g1', 'agt_test');
    await waitFor(sm, 'session:connected');
    sm.connectGroup('sess-g1', 'agt_test'); // no-op
    await new Promise(r => setTimeout(r, 50));

    expect(connections).toBe(1);
  });

  it('send() in group mode wraps a participant-scoped envelope with sender.participantId + mentions', async () => {
    let captured: Record<string, unknown> | undefined;
    mockGroupServer(wss, { participantId: 'part-xyz', onClientMessage: f => { captured = f; } });

    sm.connectGroup('sess-g1', 'agt_test');
    await waitFor(sm, 'session:participant'); // wait for participantId to be cached

    const ok = sm.send('sess-g1', {
      type: 'result.success',
      payload: { content: 'hi', usage: { totalTokens: 42 } },
      mentions: ['part-consumer-1'],
    });
    expect(ok).toBe(true);
    await new Promise(r => setTimeout(r, 30));

    expect(captured).toBeDefined();
    expect((captured as Record<string, unknown>)['type']).toBe('result.success');
    const sender = (captured as Record<string, unknown>)['sender'] as Record<string, unknown>;
    expect(sender['participantId']).toBe('part-xyz');
    expect(sender['side']).toBe('provider');
    expect(sender['agentId']).toBe('agent-1');
    expect((captured as Record<string, unknown>)['mentions']).toEqual(['part-consumer-1']);
  });

  it('does NOT include mentions when the caller omits them', async () => {
    let captured: Record<string, unknown> | undefined;
    mockGroupServer(wss, { onClientMessage: f => { captured = f; } });

    sm.connectGroup('sess-g1', 'agt_test');
    await waitFor(sm, 'session:participant');

    sm.send('sess-g1', { type: 'dialogue.message', payload: { content: 'plain' } });
    await new Promise(r => setTimeout(r, 30));

    expect((captured as Record<string, unknown>)['mentions']).toBeUndefined();
  });

  it('terminal close 4013 (no active participant) emits session:dead and does NOT reconnect', async () => {
    const seenConnections: WebSocket[] = [];
    wss.on('connection', s => seenConnections.push(s));
    mockGroupServer(wss, { terminalCode: 4013 });

    const reconnecting = vi.fn();
    sm.on('session:reconnecting', reconnecting);

    sm.connectGroup('sess-g1', 'agt_test');
    const [sid, reason] = await waitFor<string>(sm, 'session:dead');

    expect(sid).toBe('sess-g1');
    expect(String(reason)).toContain('4013');
    await new Promise(r => setTimeout(r, 80)); // give a would-be reconnect time to (not) fire
    expect(reconnecting).not.toHaveBeenCalled();
    expect(seenConnections.length).toBe(1); // no second connection
    expect(sm.activeCount).toBe(0);
  });

  it('routes presence/ack frames to session:presence, NOT session:message', async () => {
    mockGroupServer(wss, {
      extraFrames: [
        { type: 'system.participant_joined', payload: { participant: { participantId: 'part-c1' } } },
        { type: 'system.message_ack', payload: { id: 'm1', delivered: true } },
        { type: 'dialogue.message', payload: { content: 'hello' } },
      ],
    });

    const presence: string[] = [];
    const messages: string[] = [];
    sm.on('session:presence', (_sid: string, frame: Record<string, unknown>) => presence.push(frame['type'] as string));
    sm.on('session:message', (_sid: string, frame: Record<string, unknown>) => messages.push(frame['type'] as string));

    sm.connectGroup('sess-g1', 'agt_test');
    await waitFor(sm, 'session:connected');
    // Wait for the extra frames to be delivered + routed.
    await new Promise(r => setTimeout(r, 50));

    expect(presence).toEqual(expect.arrayContaining(['system.participant_joined', 'system.message_ack']));
    expect(messages).toEqual(['dialogue.message']); // real messages still fire onMessage
  });

  it('sendTyping-style typing frame is still deliverable in group mode (no short-circuit in SM)', async () => {
    // SM is transport-only; whether typing should be sent is a ProviderClient policy
    // (ProviderClient.sendTyping no-ops in group mode). At the SM level, any frame
    // type is wrapped + sent. This pins that transport behavior.
    let captured: Record<string, unknown> | undefined;
    mockGroupServer(wss, { onClientMessage: f => { captured = f; } });

    sm.connectGroup('sess-g1', 'agt_test');
    await waitFor(sm, 'session:participant');

    sm.send('sess-g1', { type: 'dialogue.typing', payload: {} });
    await new Promise(r => setTimeout(r, 30));

    expect((captured as Record<string, unknown>)['type']).toBe('dialogue.typing');
  });
});

describe('SessionManager /ws/session mode (backward compatibility)', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as AddressInfo).port;
  });
  afterEach(() => { wss.close(); });

  it('connect() still works and send() uses the legacy role-scoped sender', async () => {
    let captured: Record<string, unknown> | undefined;
    wss.on('connection', (sock, req) => {
      expect(req.url ?? '').toContain('/ws/session');
      sock.on('message', raw => {
        try { captured = JSON.parse(raw.toString()); } catch { /* ignore */ }
      });
    });

    const sm = new SessionManager(`ws://localhost:${port}`, 25_000, 1_000, 5);
    sm.agentId = 'agent-1';
    sm.connect('sess-s1', 'st-1');
    await waitFor(sm, 'session:connected');

    sm.send('sess-s1', { type: 'result.success', payload: {} });
    await new Promise(r => setTimeout(r, 30));

    const sender = (captured as Record<string, unknown>)['sender'] as Record<string, unknown>;
    expect(sender['role']).toBe('provider');
    expect(sender['agentId']).toBe('agent-1');
    expect((captured as Record<string, unknown>)['mentions']).toBeUndefined();
    sm.disconnectAll();
  });
});
