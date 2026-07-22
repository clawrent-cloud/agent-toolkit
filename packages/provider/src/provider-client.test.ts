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
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
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
    // Task 4: start() now awaits first activateAgent — stub it to resolve immediately.
    vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);
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
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
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
    // Task 4: start() now awaits first activateAgent — stub it to resolve immediately.
    vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);
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
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
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
    // Task 4: start() now awaits first activateAgent — stub it to resolve immediately.
    vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);
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
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
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
    // Task 4: start() now awaits first activateAgent — stub it to resolve immediately.
    vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);
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

describe('ProviderClient.start getMyAgent retry (symptom A fix)', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
  });
  afterEach(() => { wss.close(); });

  it('retries getMyAgent on transient fetch failure then succeeds', async () => {
    wss.on('connection', sock => {
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_clawrent_xxx',
      restRetryInitialMs: 5,
      restRetryMaxDelayMs: 20,
    });
    const getMyAgent = vi
      .spyOn(c['client'], 'getMyAgent')
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce({ id: 'agent-1' });
    // stub activation so start() doesn't hit /activate (no HTTP server on this port)
    vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);

    await c.start({ onMessage: async () => {} });
    expect(c.running).toBe(true);
    expect(getMyAgent).toHaveBeenCalledTimes(3);
    c.stop();
  });

  it('rejects start() immediately when getMyAgent returns 4xx (bad token, terminal)', async () => {
    const c = new ProviderClient({
      apiUrl: 'http://localhost:1', // unreachable but getMyAgent is mocked below
      wsUrl: 'ws://localhost:1',
      agentToken: 'agt_bad',
      restRetryInitialMs: 5,
      restRetryMaxDelayMs: 20,
    });
    vi.spyOn(c['client'], 'getMyAgent').mockRejectedValue(new Error('API error 401: invalid token'));
    await expect(c.start({ onMessage: async () => {} })).rejects.toThrow('API error 401');
    expect(c.running).toBe(false);
  });
});

describe('ProviderClient activation self-heal (symptom B fix, α semantics)', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
  });
  afterEach(() => { wss.close(); });

  it('start() resolves only after first activateAgent succeeds (α)', async () => {
    wss.on('connection', sock => {
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      restRetryInitialMs: 5,
      restRetryMaxDelayMs: 20,
    });
    let activateCalled = 0;
    vi.spyOn(c['client'], 'activateAgent').mockImplementation(async () => {
      activateCalled++;
      if (activateCalled === 1) throw new TypeError('fetch failed'); // transient
      return {} as never;
    });
    const activated: string[] = [];
    c.on('agent:activated', () => activated.push('activated'));

    await c.start({ agentId: 'agent-1', onMessage: async () => {} });
    expect(c.running).toBe(true);          // α: start() resolved => activation succeeded
    expect(activateCalled).toBeGreaterThanOrEqual(2);
    expect(activated).toContain('activated');
    c.stop();
  });

  it('start() stays pending while activateAgent persistently fails (network); emits agent:warning (not silent)', async () => {
    wss.on('connection', sock => {
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      restRetryInitialMs: 5,
      restRetryMaxDelayMs: 10,
    });
    vi.spyOn(c['client'], 'activateAgent').mockRejectedValue(new TypeError('fetch failed'));
    const warnings: string[] = [];
    c.on('agent:warning', (m: string) => warnings.push(m));

    let resolved = false;
    let rejected = false;
    void c.start({ agentId: 'agent-1', onMessage: async () => {} })
      .then(() => { resolved = true; })
      .catch(() => { rejected = true; });
    await new Promise(r => setTimeout(r, 60)); // let a few retry attempts fire
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);              // still pending — α (persistent retry, not terminal)
    expect(c.running).toBe(false);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes('activation attempt'))).toBe(true);
    c.stop();
  });

  it('rejects start() on terminal 4xx activation error (and emits agent:activation:failed)', async () => {
    wss.on('connection', sock => {
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      restRetryInitialMs: 5,
      restRetryMaxDelayMs: 10,
    });
    vi.spyOn(c['client'], 'activateAgent').mockRejectedValue(new Error('API error 403: not approved'));
    const failed: unknown[] = [];
    c.on('agent:activation:failed', (aid: unknown, err: unknown) => failed.push({ aid, err }));

    await expect(c.start({ agentId: 'agent-1', onMessage: async () => {} }))
      .rejects.toThrow('API error 403');
    expect(c.running).toBe(false);
    expect(failed.length).toBeGreaterThanOrEqual(1);
  });

  it('stop() during pending activation cancels the retry and rejects start()', async () => {
    wss.on('connection', sock => {
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      restRetryInitialMs: 20,
      restRetryMaxDelayMs: 40,
    });
    const activate = vi.spyOn(c['client'], 'activateAgent').mockRejectedValue(new TypeError('fetch failed'));

    let resolved = false;
    let rejected = false;
    void c.start({ agentId: 'agent-1', onMessage: async () => {} })
      .then(() => { resolved = true; })
      .catch(() => { rejected = true; });
    await new Promise(r => setTimeout(r, 30)); // let a couple activation attempts fire
    expect(activate.mock.calls.length).toBeGreaterThan(0);
    expect(resolved).toBe(false);

    c.stop(); // cancels the retry + rejects start()
    await new Promise(r => setTimeout(r, 50));
    expect(rejected).toBe(true);   // start() rejected — no hang
    expect(resolved).toBe(false);
    const callsAfterStop = activate.mock.calls.length;
    await new Promise(r => setTimeout(r, 80));
    expect(activate.mock.calls.length).toBe(callsAfterStop); // retry cancelled — no further calls
  });
});

describe('ProviderClient /ws/agent reconnect (bonus fix)', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
  });
  afterEach(() => { wss.close(); });

  async function started(c: ProviderClient): Promise<void> {
    vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);
    await c.start({ agentId: 'agent-1', onMessage: async () => {} });
  }

  it('reconnects after abnormal close (server drops socket)', async () => {
    const connections: number[] = [];
    wss.on('connection', sock => {
      connections.push(connections.length + 1);
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      agentReconnectInitialMs: 10,
      agentReconnectMaxDelayMs: 20,
    });
    const reconnecting: number[] = [];
    c.on('agent:reconnecting', (delay: number) => reconnecting.push(delay));

    await started(c);
    const firstWs = c['agentWs'];
    for (const clientSock of wss.clients) clientSock.terminate(); // server forces abnormal close
    await new Promise(r => setTimeout(r, 80)); // allow backoff + reconnect
    expect(reconnecting.length).toBeGreaterThan(0);
    expect(c['agentWs']).not.toBe(firstWs); // new socket created
    c.stop();
  });

  it('does NOT reconnect on terminal close 4001 (invalid token), emits agent:dead', async () => {
    let firstConn = true;
    wss.on('connection', sock => {
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      if (firstConn) { firstConn = false; sock.close(4001, 'Invalid agent token'); return; }
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_bad',
      agentReconnectInitialMs: 10,
      agentReconnectMaxDelayMs: 20,
    });
    vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);
    const dead: { aid: unknown; reason: unknown }[] = [];
    c.on('agent:dead', (aid: unknown, reason: unknown) => dead.push({ aid, reason }));

    await c.start({ agentId: 'agent-1', onMessage: async () => {} });
    // firstActivation already resolved (activateAgent stubbed) before the 4001 close hits;
    // _running is true. The 4001 close must emit agent:dead and NOT reconnect.
    await new Promise(r => setTimeout(r, 60));
    expect(dead.length).toBeGreaterThanOrEqual(1);
    expect(String(dead[0]!.reason)).toContain('4001');
    expect(c.running).toBe(false); // terminal close -> running getter accurate (not lying true)
    c.stop();
  });

  it('does NOT reconnect after stop()', async () => {
    const connections: number[] = [];
    wss.on('connection', sock => {
      connections.push(connections.length + 1);
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      agentReconnectInitialMs: 10,
      agentReconnectMaxDelayMs: 20,
    });
    const reconnecting: unknown[] = [];
    c.on('agent:reconnecting', () => reconnecting.push(true));

    await started(c);
    c.stop(); // sets _running=false, clears reconnect timer
    const countAfterStop = connections.length;
    for (const clientSock of wss.clients) clientSock.terminate();
    await new Promise(r => setTimeout(r, 60));
    expect(connections.length).toBe(countAfterStop); // no new connection
    expect(reconnecting.length).toBe(0);
  });

  it('reconnects when /ws/agent closes during the start window (activate still retrying) — not suppressed', async () => {
    let firstConn = true;
    wss.on('connection', sock => {
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      if (firstConn) { firstConn = false; setTimeout(() => { try { sock.terminate() } catch { /* closed */ } }, 15); }
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      restRetryInitialMs: 40,
      restRetryMaxDelayMs: 80,
      agentReconnectInitialMs: 10,
      agentReconnectMaxDelayMs: 20,
    });
    let activateCalls = 0;
    vi.spyOn(c['client'], 'activateAgent').mockImplementation(async () => {
      activateCalls++;
      if (activateCalls < 3) throw new TypeError('fetch failed');
      return {} as never;
    });
    const reconnecting: number[] = [];
    c.on('agent:reconnecting', (d: number) => reconnecting.push(d));

    await c.start({ agentId: 'agent-1', onMessage: async () => {} });
    // During the start window (_running still false), the first WS was terminated
    // (~15ms) while activate was retrying. The reconnect MUST have fired (gated on
    // _stopped, not _running). Before the fix this was suppressed → silent offline.
    expect(reconnecting.length).toBeGreaterThanOrEqual(1);
    expect(c.running).toBe(true);
    c.stop();
  });
});

describe('ProviderClient.retryWithBackoff cancellable sleep (#2)', () => {
  let client: ProviderClient;

  beforeEach(() => {
    client = new ProviderClient({ agentToken: 'agt_test' });
  });

  it('cancels mid-sleep within ~200ms when isCancelled flips (does not stall maxDelayMs)', async () => {
    // fn always fails with a retryable network error -> enters backoff sleep
    const fn = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
    let cancelled = false;
    const start = Date.now();
    const p = client['retryWithBackoff'](fn, {
      initialMs: 2_500, // first backoff delay = 2500ms; would stall if sleep weren't cancellable
      maxDelayMs: 30_000,
      isCancelled: () => cancelled,
    });
    // flip cancel shortly after the first sleep begins
    await new Promise(r => setTimeout(r, 120));
    cancelled = true;
    await expect(p).rejects.toThrow('cancelled');
    const elapsed = Date.now() - start;
    // Should return well under the 2500ms backoff (cancellation latency ~120-200ms).
    expect(elapsed).toBeLessThan(2_000);
  });

  it('still sleeps the full delay when not cancelled', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce('ok');
    const start = Date.now();
    await client['retryWithBackoff'](fn, { initialMs: 80, maxDelayMs: 200 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(75); // slept ~80ms
  });
});

describe('ProviderClient first /ws/agent handshake retry (#1)', () => {
  it('retries the first WS connect on failure instead of rejecting start()', async () => {
    // Port with nothing listening -> first connect fails (ECONNREFUSED) and keeps failing.
    const c = new ProviderClient({
      apiUrl: 'http://localhost:1', // REST not reached: agentId passed + activateAgent stubbed
      wsUrl: 'ws://localhost:1',    // nothing listening -> WS connect error
      agentToken: 'agt_x',
      agentReconnectInitialMs: 20,
      agentReconnectMaxDelayMs: 40,
    });
    vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);
    const reconnecting: unknown[] = [];
    c.on('agent:reconnecting', () => reconnecting.push(true));

    // Real ws://localhost:1 keeps failing; start() should stay pending (persistently
    // retrying), NOT reject. Before #1 it rejected immediately.
    let resolved = false;
    let rejected = false;
    void c.start({ agentId: 'agent-1', onMessage: async () => {} })
      .then(() => { resolved = true; })
      .catch(() => { rejected = true; });
    await new Promise(r => setTimeout(r, 150)); // let a few reconnect attempts fire
    expect(resolved).toBe(false);
    expect(rejected).toBe(false);   // NOT rejected — this is the #1 fix
    expect(reconnecting.length).toBeGreaterThan(0);
    c.stop();
  });

  it('first WS connect failure then success: start() resolves once open+activate', async () => {
    // Server rejects the first 2 WS handshakes (verifyClient -> 403), then accepts.
    // Each rejected handshake -> client 'error'+'close' -> close handler schedules
    // a reconnect. Before #1, the first rejection rejected start(); now it retries.
    let rejectionsLeft = 2;
    const wss = new WebSocketServer({
      port: 0,
      verifyClient: (_info, cb) => {
        if (rejectionsLeft > 0) { rejectionsLeft--; cb(false, 403, 'rejected'); return; }
        cb(true);
      },
    });
    const port = (wss.address() as { port: number }).port;
    wss.on('connection', sock => {
      sock.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    try {
      const c = new ProviderClient({
        apiUrl: `http://localhost:${port}`,
        wsUrl: `ws://localhost:${port}`,
        agentToken: 'agt_x',
        agentReconnectInitialMs: 30,
        agentReconnectMaxDelayMs: 60,
      });
      vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);

      await c.start({ agentId: 'agent-1', onMessage: async () => {} });
      expect(c.running).toBe(true); // first 2 handshakes rejected, a later one succeeds
      c.stop();
    } finally {
      wss.close();
    }
  });
});

describe('ProviderClient activate waits for agent.connected welcome (#4)', () => {
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    wss = new WebSocketServer({ port: 0 });
    port = (wss.address() as { port: number }).port;
  });
  afterEach(() => { wss.close(); });

  it('does NOT call activateAgent before receiving agent.connected welcome', async () => {
    // Server accepts the socket but does NOT send the agent.connected welcome —
    // simulating the backend async window before registerAgentClient finishes.
    wss.on('connection', sock => {
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      activateWelcomeTimeoutMs: 60_000, // effectively disable — we drive the welcome manually
    });
    const activate = vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);

    let started = false;
    void c.start({ agentId: 'agent-1', onMessage: async () => {} }).then(() => { started = true; });
    await new Promise(r => setTimeout(r, 100)); // open + sit idle (no welcome yet)
    expect(activate).not.toHaveBeenCalled(); // #4: activate held back until welcome
    expect(started).toBe(false);

    // Now push the welcome -> activate should fire.
    for (const s of wss.clients) s.send(JSON.stringify({ type: 'agent.connected', payload: { agentId: 'agent-1' } }));
    await new Promise(r => setTimeout(r, 80));
    expect(activate).toHaveBeenCalled();
    expect(started).toBe(true);
    c.stop();
  });

  it('falls back to direct activate after welcome timeout (degrades to old behavior)', async () => {
    // Server never sends the welcome; the conservative timeout falls back to activate.
    wss.on('connection', sock => {
      sock.on('message', m => {
        const msg = JSON.parse(m.toString());
        if (msg.type === 'system.heartbeat') sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
      });
    });
    const c = new ProviderClient({
      apiUrl: `http://localhost:${port}`,
      wsUrl: `ws://localhost:${port}`,
      agentToken: 'agt_x',
      activateWelcomeTimeoutMs: 100, // short for the test
    });
    const activate = vi.spyOn(c['client'], 'activateAgent').mockResolvedValue({} as never);
    await c.start({ agentId: 'agent-1', onMessage: async () => {} }); // resolves after timeout fallback
    expect(activate).toHaveBeenCalled();
    expect(c.running).toBe(true);
    c.stop();
  });
});
