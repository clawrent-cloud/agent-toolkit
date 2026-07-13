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
    // We drive the cursor/dedupe path directly via the test hook.
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
    c['handleSessionMessage']('sess-1', frame);
    c['handleSessionMessage']('sess-1', frame); // duplicate -> deduped
    await new Promise(r => setImmediate(r));

    expect(received).toEqual(['hello']); // only once
    expect(cursor.get('sess-1')).toBe('2026-07-13T00:00:00.000Z');
    c.stop();
  });
});
