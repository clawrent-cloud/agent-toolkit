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

describe('ProviderClient.sendTyping', () => {
  // Baseline well above 0 so the first send (last=0) clears the debounce
  // window, as it does with real epoch-ms timestamps (where Date.now() is large).
  const T0 = 1_700_000_000_000;
  let client: ProviderClient;
  let mockSm: { isConnected: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    client = new ProviderClient({ agentToken: 'agt_test' });
    mockSm = {
      isConnected: vi.fn().mockReturnValue(true),
      send: vi.fn().mockReturnValue(true),
    };
    // Inject a mock SessionManager (private at the type level; runtime-accessible).
    (client as unknown as { sessionManager: unknown }).sessionManager = mockSm;
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false and does not send when the session socket is not OPEN', () => {
    mockSm.isConnected.mockReturnValue(false);
    expect(client.sendTyping('s1')).toBe(false);
    expect(mockSm.send).not.toHaveBeenCalled();
  });

  it('returns false when no SessionManager is attached (before start)', () => {
    const fresh = new ProviderClient({ agentToken: 'agt_test' });
    // sessionManager is null until start() — sendTyping must no-op, not throw.
    expect(fresh.sendTyping('s1')).toBe(false);
  });

  it('sends a dialogue.typing frame and returns true when connected', () => {
    expect(client.sendTyping('s1')).toBe(true);
    expect(mockSm.send).toHaveBeenCalledTimes(1);
    expect(mockSm.send).toHaveBeenCalledWith('s1', {
      type: 'dialogue.typing',
      payload: {},
    });
  });

  it('debounces to one send per 500ms per session', () => {
    expect(client.sendTyping('s1')).toBe(true); // t=T0 → sends (T0-0 > 500)
    vi.setSystemTime(T0 + 100);
    expect(client.sendTyping('s1')).toBe(false); // suppressed (100 < 500)
    vi.setSystemTime(T0 + 499);
    expect(client.sendTyping('s1')).toBe(false); // still suppressed (499 < 500)
    vi.setSystemTime(T0 + 500);
    expect(client.sendTyping('s1')).toBe(true); // exactly 500ms → sends again
    expect(mockSm.send).toHaveBeenCalledTimes(2);
  });

  it('tracks the debounce window per session independently', () => {
    expect(client.sendTyping('s1')).toBe(true); // t=T0, s1
    vi.setSystemTime(T0 + 100);
    expect(client.sendTyping('s2')).toBe(true); // t=T0+100, s2 — different session, not suppressed
    expect(mockSm.send).toHaveBeenCalledTimes(2);
    expect(mockSm.send).toHaveBeenNthCalledWith(1, 's1', { type: 'dialogue.typing', payload: {} });
    expect(mockSm.send).toHaveBeenNthCalledWith(2, 's2', { type: 'dialogue.typing', payload: {} });
  });
});

describe('ProviderClient.retryWithBackoff', () => {
  let client: ProviderClient;

  beforeEach(() => {
    client = new ProviderClient({ agentToken: 'agt_test' });
  });

  it('returns the value when fn succeeds on first try (no retry)', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const res = await client['retryWithBackoff'](fn, { initialMs: 10, maxDelayMs: 50 });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on network-like errors until success', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    const res = await client['retryWithBackoff'](fn, { initialMs: 10, maxDelayMs: 50 });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry on terminal 4xx errors (throws immediately)', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('API error 401: Unauthorized'));
    await expect(client['retryWithBackoff'](fn, { initialMs: 10, maxDelayMs: 50 }))
      .rejects.toThrow('API error 401');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on 5xx and 429', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('API error 500: boom'))
      .mockRejectedValueOnce(new Error('API error 429: slow down'))
      .mockResolvedValueOnce('ok');
    const res = await client['retryWithBackoff'](fn, { initialMs: 10, maxDelayMs: 50 });
    expect(res).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects maxAttempts (gives up after N retries)', async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(client['retryWithBackoff'](fn, { initialMs: 10, maxDelayMs: 50, maxAttempts: 3 }))
      .rejects.toThrow();
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('invokes onRetry(attempt, err, delayMs) before each backoff sleep', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    await client['retryWithBackoff'](fn, { initialMs: 10, maxDelayMs: 50, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]![0]).toBe(1); // attempt
    expect((onRetry.mock.calls[0]![1] as Error).message).toBe('fetch failed');
    expect(onRetry.mock.calls[0]![2]).toBe(10); // delayMs = initialMs * 2^0 = 10
  });
});
