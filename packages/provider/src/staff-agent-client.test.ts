import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, WebSocket, type WebSocket as WsSock } from 'ws';
import { StaffTaskAckFrameSchema, StaffTaskResultFrameSchema } from '@clawrent/protocol';
import { StaffAgentClient, type StaffAgentClientOptions } from './staff-agent-client.js';

let wss: WebSocketServer;
let port: number;

beforeEach(async () => {
  wss = new WebSocketServer({ port: 0 });
  port = (wss.address() as AddressInfo).port;
});
afterEach(() => { wss.close(); });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DEFAULT_HELLO = {
  type: 'staff.hello',
  staffId: 'stf-001',
  displayName: 'Ops Bot',
  department: 'engineering',
  grants: [{ actionId: 'github.create_issue', autonomy: 'autonomous' }],
  delegation: { id: 'dlg-1', label: 'eng-ops' },
};

/** Valid StaffTaskPayload-shaped object (protocol 0.4.0 contract). */
function makeTask(id: string): Record<string, unknown> {
  return {
    id,
    actionId: 'github.create_issue',
    source: 'session:sess-123',
    targetType: 'github',
    targetId: 'clawrent-cloud/agent-toolkit',
    params: { title: `Task ${id}` },
    retryCount: 0,
    createdAt: new Date().toISOString(),
    expiresAt: null,
  };
}

interface MockServerOpts {
  /** Outbound hello frame override (defaults to a schema-valid hello). */
  hello?: Record<string, unknown>;
  /** When set, a staff.tasks_snapshot frame follows the hello. */
  snapshotTasks?: Record<string, unknown>[];
  /** When set, the server closes with this code 10ms after connect (after hello). */
  terminalCode?: number;
  onClientMessage?: (frame: Record<string, unknown>, sock: WsSock) => void;
}

/** Minimal mock of apps/platform-api ws-staff-handler: asserts the client hit
 *  /ws/staff with a token query param, greets with staff.hello (+ optional
 *  snapshot), optionally closes with a code, and captures inbound frames. */
function mockStaffServer(opts: MockServerOpts = {}): void {
  wss.on('connection', (sock: WsSock, req) => {
    expect(req.url ?? '').toContain('/ws/staff');
    expect(req.url ?? '').toContain('token=stf_test_token');

    sock.send(JSON.stringify(opts.hello ?? DEFAULT_HELLO));
    if (opts.snapshotTasks) {
      sock.send(JSON.stringify({ type: 'staff.tasks_snapshot', tasks: opts.snapshotTasks }));
    }
    if (opts.terminalCode !== undefined) {
      // Defer so the client receives the hello first.
      setTimeout(() => { try { sock.close(opts.terminalCode as number, 'rejected'); } catch { /* closed */ } }, 10);
    }

    sock.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()) as Record<string, unknown>; } catch { return; }
      opts.onClientMessage?.(msg, sock);
    });
  });
}

function makeClient(opts: Partial<StaffAgentClientOptions> = {}): StaffAgentClient {
  return new StaffAgentClient({
    apiUrl: `http://localhost:${port}`,
    wsUrl: `ws://localhost:${port}`,
    staffToken: 'stf_test_token',
    heartbeatIntervalMs: 10_000, // no heartbeat fires inside a test window
    ...opts,
  });
}

describe('StaffAgentClient', () => {
  it('start resolves on staff.hello; snapshot tasks flow through onTask; connection stays open', async () => {
    mockStaffServer({ snapshotTasks: [makeTask('task-1'), makeTask('task-2')] });
    const c = makeClient();
    let helloStaffId: string | undefined;
    let helloGrant: string | undefined;
    const tasked: string[] = [];

    await c.start({
      onTask: (t) => { tasked.push(t.id); },
      onHello: (h) => { helloStaffId = h.staffId; helloGrant = h.grants[0]?.actionId; },
    });
    await sleep(80); // let the snapshot land

    expect(helloStaffId).toBe('stf-001');
    expect(helloGrant).toBe('github.create_issue');
    expect(tasked.sort()).toEqual(['task-1', 'task-2']);
    // The client sends nothing back for hello/snapshot, but the connection is kept:
    expect((c as unknown as { ws: WebSocket | null }).ws?.readyState).toBe(WebSocket.OPEN);
    c.stop();
  });

  it('staff.task -> ackTask + resultTask deliver schema-valid frames to the server', async () => {
    const received: Record<string, unknown>[] = [];
    mockStaffServer({
      onClientMessage: (f) => { received.push(f); },
    });
    const c = makeClient();
    await c.start({
      onTask: (t, client) => {
        client.ackTask(t.id);
        client.resultTask(t.id, {
          proposedAction: {
            targetType: 'github',
            targetId: 'clawrent-cloud/agent-toolkit',
            params: { title: 'Bug: repro', labels: ['bug'] },
          },
          reasoning: 'repro confirmed; filing issue',
        });
      },
    });
    await sleep(50);

    for (const sock of wss.clients) {
      sock.send(JSON.stringify({ type: 'staff.task', task: makeTask('task-9') }));
    }
    await sleep(80);

    const ack = received.find((f) => f['type'] === 'staff.task_ack');
    const result = received.find((f) => f['type'] === 'staff.task_result');
    // Exact JSON shape the platform expects:
    expect(ack).toEqual({ type: 'staff.task_ack', taskId: 'task-9' });
    expect(result).toEqual({
      type: 'staff.task_result',
      taskId: 'task-9',
      reasoning: 'repro confirmed; filing issue',
      proposedAction: {
        targetType: 'github',
        targetId: 'clawrent-cloud/agent-toolkit',
        params: { title: 'Bug: repro', labels: ['bug'] },
      },
    });
    // And both parse against the protocol 0.4.0 schemas (contract-level check):
    expect(StaffTaskAckFrameSchema.safeParse(ack).success).toBe(true);
    expect(StaffTaskResultFrameSchema.safeParse(result).success).toBe(true);
    c.stop();
  });

  it('close(4016) is terminal: no reconnect, isTerminalDead() true', async () => {
    let connections = 0;
    mockStaffServer({ terminalCode: 4016 });
    wss.on('connection', () => connections++);
    const c = makeClient();
    await c.start({ onTask: () => {} });
    expect(connections).toBe(1);

    await sleep(1_500); // > first backoff delay (1s) — a reconnect would have landed

    expect(connections).toBe(1); // no second connection was attempted
    expect(c.isTerminalDead()).toBe(true);
    c.stop();
  });

  it('close(4012) is terminal too (same path as 4016)', async () => {
    let connections = 0;
    mockStaffServer({ terminalCode: 4012 });
    wss.on('connection', () => connections++);
    const c = makeClient();
    await c.start({ onTask: () => {} });
    await sleep(1_500);

    expect(connections).toBe(1);
    expect(c.isTerminalDead()).toBe(true);
    c.stop();
  });

  it('non-terminal close (1006 via terminate) reconnects with backoff', async () => {
    let connections = 0;
    mockStaffServer({});
    wss.on('connection', () => connections++);
    const c = makeClient();
    await c.start({ onTask: () => {} });
    expect(connections).toBe(1);

    for (const sock of wss.clients) sock.terminate(); // abnormal 1006, not terminal
    await sleep(1_600); // first backoff = 1s

    expect(connections).toBe(2); // reconnected
    expect(c.isTerminalDead()).toBe(false);
    c.stop();
  });

  it('query matches staff.query_response by queryId (data) and resolves the error variant', async () => {
    const seenQueryIds: string[] = [];
    mockStaffServer({
      onClientMessage: (f, sock) => {
        if (f['type'] !== 'staff.query') return;
        const q = f as unknown as { queryId: string; queryType: string };
        seenQueryIds.push(q.queryId);
        if (q.queryType === 'staff.get_department_tasks') {
          sock.send(JSON.stringify({
            type: 'staff.query_response',
            queryId: q.queryId,
            data: { tasks: [{ id: 't1', status: 'pending' }] },
          }));
        } else {
          sock.send(JSON.stringify({
            type: 'staff.query_response',
            queryId: q.queryId,
            error: 'query not permitted or unsupported',
          }));
        }
      },
    });
    const c = makeClient();
    await c.start({ onTask: () => {} });

    const ok = await c.query('staff.get_department_tasks', { limit: 5 });
    expect(ok.data).toEqual({ tasks: [{ id: 't1', status: 'pending' }] });
    expect(ok.error).toBeUndefined();

    const bad = await c.query('staff.not_a_thing');
    expect(bad.error).toBe('query not permitted or unsupported');
    expect(bad.data).toBeUndefined();

    // queryId is a self-incrementing counter matched 1:1 with requests:
    expect(seenQueryIds).toEqual(['q-1', 'q-2']);
    c.stop();
  });

  it('query rejects after the timeout when no response arrives', async () => {
    mockStaffServer({});
    const c = makeClient({ queryTimeoutMs: 50 });
    await c.start({ onTask: () => {} });

    await expect(c.query('staff.get_department_tasks')).rejects.toThrow(/timed out/);
    c.stop();
  });

  it('query rejects immediately when the connection is not open', async () => {
    const c = makeClient(); // never started
    await expect(c.query('staff.get_department_tasks')).rejects.toThrow(/not open/);
  });

  it('start rejects with staff hello timeout when the server never greets', async () => {
    wss.on('connection', () => { /* silent: no hello */ });
    const c = makeClient({ helloTimeoutMs: 50 });
    await expect(c.start({ onTask: () => {} })).rejects.toThrow('staff hello timeout');
  });

  it('stop() during the hello wait rejects start() instead of hanging forever', async () => {
    wss.on('connection', () => { /* silent: start() stays inside its hello wait */ });
    const c = makeClient({ helloTimeoutMs: 5_000 });
    const startPromise = c.start({ onTask: () => {} });
    await sleep(50); // connection established, start() still pending

    c.stop();

    await expect(startPromise).rejects.toThrow('staff client stopped');
  });

  it('non-terminal disconnect rejects in-flight queries immediately (not as a 60s timeout)', async () => {
    mockStaffServer({});
    const c = makeClient({ queryTimeoutMs: 60_000 }); // full window: must NOT be the timeout path
    await c.start({ onTask: () => {} });

    const pendingQuery = c.query('staff.get_department_tasks');
    await sleep(20); // let the request frame go out
    for (const sock of wss.clients) sock.terminate(); // 1006 — reconnectable, not terminal

    await expect(pendingQuery).rejects.toThrow(/query lost/);
    c.stop();
  });

  it('stop() is idempotent and safe before start', () => {
    const c = makeClient();
    expect(() => { c.stop(); c.stop(); }).not.toThrow();
    expect(c.isTerminalDead()).toBe(false);
  });
});
