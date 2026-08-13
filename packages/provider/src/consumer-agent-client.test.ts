import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocketServer } from 'ws';
import { ConsumerAgentClient } from './consumer-agent-client.js';

let wss: WebSocketServer;
let port: number;

beforeEach(async () => {
  wss = new WebSocketServer({ port: 0 });
  port = (wss.address() as { port: number }).port;
});
afterEach(() => { wss.close(); });

/** Minimal /ws/group mock: sends system.connected handshake with a participantId,
 *  acks heartbeats, and optionally captures inbound frames. */
function mockGroupServer(opts: { participantId?: string; onMessage?: (frame: Record<string, unknown>) => void } = {}): void {
  const participantId = opts.participantId ?? 'part-cons-1';
  wss.on('connection', (sock) => {
    sock.send(JSON.stringify({
      type: 'system.connected',
      payload: { participant: { participantId, participantType: 'agent', side: 'consumer', agentId: 'agent-1' } },
    }));
    sock.on('message', (m) => {
      const msg = JSON.parse(m.toString()) as Record<string, unknown>;
      if (msg['type'] === 'system.heartbeat') {
        sock.send(JSON.stringify({ type: 'system.heartbeat_ack' }));
        return;
      }
      opts.onMessage?.(msg);
    });
  });
}

function makeClient(): ConsumerAgentClient {
  return new ConsumerAgentClient({
    apiUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}`,
    agentToken: 'agt_cons_xxx',
    agentId: 'agent-1',
    heartbeatIntervalMs: 100,
  });
}

describe('ConsumerAgentClient', () => {
  it('start connects /ws/group for each sessionId and caches participantId from handshake', async () => {
    mockGroupServer({ participantId: 'part-xyz' });
    const c = makeClient();
    const participantEvents: string[] = [];
    c.on('session:participant', (sid: string) => participantEvents.push(sid));

    await c.start({ sessionIds: ['sess-1'], onMessage: async () => {} });
    await new Promise((r) => setTimeout(r, 80));

    expect(c.running).toBe(true);
    expect(participantEvents).toContain('sess-1');
    const pid = (c as unknown as { activeSessions: Map<string, { participantId?: string }> }).activeSessions.get('sess-1')?.participantId;
    expect(pid).toBe('part-xyz');
    c.stop();
  });

  it('delivers inbound /ws/group messages to onMessage', async () => {
    const received: string[] = [];
    mockGroupServer();
    const c = makeClient();
    await c.start({
      sessionIds: ['sess-1'],
      onMessage: async (_s, msg) => {
        received.push((msg['payload'] as { content: string }).content);
      },
    });
    await new Promise((r) => setTimeout(r, 50)); // let handshake land

    for (const sock of wss.clients) {
      sock.send(JSON.stringify({
        sessionId: 'sess-1',
        id: 'm1',
        timestamp: Date.now(),
        sender: { side: 'provider', agentId: 'agent-p' },
        type: 'dialogue.message',
        payload: { content: 'hello consumer' },
        _meta: { sessionId: 'sess-1', senderRole: 'provider', timestamp: '2026-08-13T00:00:00.000Z' },
      }));
    }
    await new Promise((r) => setTimeout(r, 80));

    expect(received).toEqual(['hello consumer']);
    c.stop();
  });

  it('dedupes repeat messages via cursor (delivered once)', async () => {
    const received: string[] = [];
    mockGroupServer();
    const c = makeClient();
    await c.start({
      sessionIds: ['sess-1'],
      onMessage: async (_s, msg) => {
        received.push((msg['payload'] as { content: string }).content);
      },
    });
    await new Promise((r) => setTimeout(r, 50));

    const frame = JSON.stringify({
      sessionId: 'sess-1',
      id: 'm1',
      timestamp: Date.now(),
      sender: { side: 'provider', agentId: 'agent-p' },
      type: 'dialogue.message',
      payload: { content: 'dup' },
      _meta: { sessionId: 'sess-1', senderRole: 'provider', timestamp: '2026-08-13T00:00:00.000Z' },
    });
    for (const sock of wss.clients) {
      sock.send(frame);
      sock.send(frame);
    }
    await new Promise((r) => setTimeout(r, 80));

    expect(received).toEqual(['dup']); // duplicate deduped
    c.stop();
  });

  it('send stamps sender.side=consumer on the outbound envelope', async () => {
    const captured: Record<string, unknown>[] = [];
    mockGroupServer({ onMessage: (f) => captured.push(f) });
    const c = makeClient();
    await c.start({ sessionIds: ['sess-1'], onMessage: async () => {} });
    await new Promise((r) => setTimeout(r, 50)); // handshake lands

    const res = await c.send('sess-1', { type: 'dialogue.message', payload: { content: 'hi from consumer agent' } });
    expect(res.delivered).toBe(true);
    await new Promise((r) => setTimeout(r, 50));

    const sent = captured.find((f) => f['type'] === 'dialogue.message');
    expect(sent).toBeDefined();
    const sender = (sent as { sender?: { side?: string; participantId?: string } }).sender;
    expect(sender?.side).toBe('consumer');
    expect(sender?.participantId).toBe('part-cons-1'); // cached from handshake
    c.stop();
  });
});

describe('ConsumerAgentClient.addSession', () => {
  it('connects a new session after start', async () => {
    mockGroupServer({ participantId: 'part-1' });
    const c = makeClient();
    const connected: string[] = [];
    c.on('session:connected', (sid: string) => connected.push(sid));

    await c.start({ sessionIds: [], onMessage: async () => {} });
    await new Promise((r) => setTimeout(r, 50));

    c.addSession('sess-new');
    await new Promise((r) => setTimeout(r, 150)); // WS connect + handshake

    expect(connected).toContain('sess-new');
    c.stop();
  });

  it('is idempotent (second call for an active session is a no-op)', async () => {
    mockGroupServer({ participantId: 'part-1' });
    const c = makeClient();
    await c.start({ sessionIds: ['sess-1'], onMessage: async () => {} });
    await new Promise((r) => setTimeout(r, 100));
    expect(() => c.addSession('sess-1')).not.toThrow();
    c.stop();
  });

  it('is a no-op before start', () => {
    const c = makeClient();
    expect(() => c.addSession('sess-1')).not.toThrow();
    expect(c.running).toBe(false);
  });
});

describe('ConsumerAgentClient.activeSessionIds getter', () => {
  it('returns the live set of session ids', async () => {
    mockGroupServer({ participantId: 'part-1' });
    const c = makeClient();
    await c.start({ sessionIds: ['sess-1', 'sess-2'], onMessage: async () => {} });
    await new Promise((r) => setTimeout(r, 100));
    expect(c.activeSessionIds.sort()).toEqual(['sess-1', 'sess-2']);
    c.stop();
  });
});

describe('ConsumerAgentClient re-emits', () => {
  it('re-emits session:reconnecting on forceDisconnect', async () => {
    mockGroupServer({ participantId: 'part-1' });
    const c = makeClient();
    const events: string[] = [];
    c.on('session:reconnecting', (sid: string) => events.push(sid));

    await c.start({ sessionIds: ['sess-1'], onMessage: async () => {} });
    await new Promise((r) => setTimeout(r, 100));

    c.forceDisconnect('sess-1');
    await new Promise((r) => setTimeout(r, 400)); // reconnect window

    expect(events).toContain('sess-1');
    c.stop();
  });
});
