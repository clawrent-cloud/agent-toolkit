import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { rmSync } from 'node:fs';
import { ProviderClient } from './provider-client.js';
import { FileCursorStore } from './cursor.js';

const TMP2 = './.tmp-cursor-int.json';

describe('ProviderClient skeleton', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
  });
  afterEach(() => {
    wss.close();
  });

  it('constructs and exposes running=false before start', () => {
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_clawrent_xxx',
    });
    expect(c.running).toBe(false);
  });

  it('start connects /ws/agent and flips running=true', async () => {
    const onConnect = vi.fn();
    wss.on('connection', sock => {
      // /ws/agent connection accepted
      onConnect();
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_clawrent_xxx',
      heartbeatIntervalMs: 100,
    });
    // agentId provided -> skips getMyAgent; activation mocked to no-op via fetch mock not needed (WS-only path)
    await c.start({ agentId: 'agent-1', onMessage: async () => {} });
    expect(c.running).toBe(true);
    expect(onConnect).toHaveBeenCalled();
    c.stop();
  });
});

describe('ProviderClient message delivery + cursor dedupe', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
    rmSync(TMP2, { force: true });
  });
  afterEach(() => {
    wss.close();
    rmSync(TMP2, { force: true });
  });

  it('delivers a consumer message to onMessage and advances cursor (dedupes duplicates)', async () => {
    const received: string[] = [];
    wss.on('connection', sock => {
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') {
          sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
          return;
        }
      });
    });
    const cursor = new FileCursorStore(TMP2);
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_clawrent_xxx',
      heartbeatIntervalMs: 100,
      cursorStore: cursor,
    });
    await c.start({
      agentId: 'agent-1',
      onMessage: async (_s, msg) => {
        received.push((msg['payload'] as { content: string }).content);
      },
    });

    // Simulate a consumer message arriving on /ws/session (provider role).
    // We drive the cursor/dedupe path directly via the test hook. The two calls
    // are awaited sequentially — direct handleSessionMessage invocations bypass
    // bindSessionManager's per-session inflight chain, so we serialize explicitly
    // here. The second call hits the cursor (now advanced) and short-circuits.
    const frame = {
      sessionId: 'sess-1',
      sessionToken: 'st-1',
      id: 'm1',
      timestamp: Date.now(),
      sender: { role: 'consumer', agentId: 'agent-1' },
      type: 'dialogue.message',
      payload: { content: 'hello' },
      _meta: { sessionId: 'sess-1', senderRole: 'consumer', timestamp: '2026-07-13T00:00:00.000Z' },
    };
    // Bracket access = test hook into the (public, no-underscore) handler.
    await c['handleSessionMessage']('sess-1', frame);
    await c['handleSessionMessage']('sess-1', frame); // duplicate -> deduped via cursor

    expect(received).toEqual(['hello']); // only once
    expect(cursor.get('sess-1')).toBe('2026-07-13T00:00:00.000Z');
    c.stop();
  });

  it('does NOT advance cursor when onMessage throws (at-least-once on redelivery)', async () => {
    let shouldThrow = true;
    const calls: number[] = [];
    wss.on('connection', sock => {
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') {
          sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
          return;
        }
      });
    });
    const cursor = new FileCursorStore(TMP2);
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_clawrent_xxx',
      heartbeatIntervalMs: 100,
      cursorStore: cursor,
    });
    const sessionErrors: unknown[] = [];
    c.on('session:error', (_sid: string, err: unknown) => sessionErrors.push(err));
    await c.start({
      agentId: 'agent-1',
      onMessage: async () => {
        calls.push(calls.length);
        if (shouldThrow) {
          shouldThrow = false;
          throw new Error('boom');
        }
      },
    });

    const frame = {
      sessionId: 'sess-1',
      sessionToken: 'st-1',
      id: 'm1',
      timestamp: Date.now(),
      sender: { role: 'consumer', agentId: 'agent-1' },
      type: 'dialogue.message',
      payload: { content: 'hello' },
      _meta: { sessionId: 'sess-1', senderRole: 'consumer', timestamp: '2026-07-13T00:00:00.000Z' },
    };

    // First delivery: onMessage throws -> cursor MUST stay un-advanced so a
    // future redelivery re-processes. session:error is emitted.
    await c['handleSessionMessage']('sess-1', frame);
    expect(calls.length).toBe(1);
    expect(cursor.get('sess-1')).toBeNull();
    expect(sessionErrors.length).toBe(1);
    expect((sessionErrors[0] as Error).message).toBe('boom');

    // Second delivery (backend redelivers on restart because cursor didn't
    // advance): cursor still empty -> passes dedupe -> onMessage runs again.
    // This is the at-least-once contract.
    await c['handleSessionMessage']('sess-1', frame);
    expect(calls.length).toBe(2);
    expect(cursor.get('sess-1')).toBe('2026-07-13T00:00:00.000Z');
    c.stop();
  });

  it('serializes concurrent session:message events per session (inflight chain)', async () => {
    const received: string[] = [];
    let processMs = 30; // simulate onMessage that takes a tick
    wss.on('connection', sock => {
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') {
          sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
          return;
        }
      });
    });
    const cursor = new FileCursorStore(TMP2);
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_clawrent_xxx',
      heartbeatIntervalMs: 100,
      cursorStore: cursor,
    });
    await c.start({
      agentId: 'agent-1',
      onMessage: async (_s, msg) => {
        await new Promise(r => setTimeout(r, processMs));
        received.push((msg['payload'] as { content: string }).content);
      },
    });

    const frame = {
      sessionId: 'sess-1',
      sessionToken: 'st-1',
      id: 'm1',
      timestamp: Date.now(),
      sender: { role: 'consumer', agentId: 'agent-1' },
      type: 'dialogue.message',
      payload: { content: 'hello' },
      _meta: { sessionId: 'sess-1', senderRole: 'consumer', timestamp: '2026-07-13T00:00:00.000Z' },
    };

    // Drive TWO SYNCHRONOUS emissions through the real session manager → the
    // per-session inflight chain in bindSessionManager MUST serialize them so
    // the second frame sees the advanced cursor and is deduped. Without the
    // chain both would pass dedupe and onMessage would fire twice.
    const sm = (c as unknown as { sessionManager: { emit: (ev: string, ...args: unknown[]) => void } }).sessionManager;
    sm.emit('session:message', 'sess-1', frame);
    sm.emit('session:message', 'sess-1', frame);
    // Wait long enough for the (processMs) chain link to settle + second to dedupe.
    await new Promise(r => setTimeout(r, processMs + 50));

    expect(received).toEqual(['hello']); // only once — serialized + deduped
    expect(cursor.get('sess-1')).toBe('2026-07-13T00:00:00.000Z');
    processMs = 0;
    c.stop();
  });
});

describe('ProviderClient.send', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(() => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
  });
  afterEach(() => {
    wss.close();
  });

  it('returns via:rest when no session WS (REST fallback)', async () => {
    // stub sendSessionMessage to avoid real HTTP
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
    });
    c['client'].sendSessionMessage = async () => ({ delivered: true }) as never;
    const res = await c.send('sess-1', { type: 'dialogue.message', payload: { content: 'hi' } });
    expect(res.via).toBe('rest');
  });
});
