import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { Mecha } from '@clawrent/protocol';
import { MECHA_PACKAGE_VERSION } from './constants.js';
import { DeviceClient } from './device-client.js';
import {
  MechaSession,
  type MechaSessionEndEvent,
} from './session.js';
import { ProvenanceStore } from './enforcement/provenance.js';
import { startMockRelay, waitFor, type MockRelay } from '../test/mock-relay.js';

// ── fixture 基建（os.tmpdir + 真实 127.0.0.1 socket，plan 全局约束）─────────

const created: string[] = [];

function makeWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** 打开的栈（client + relay），afterEach 统一收口——不留悬挂句柄给 vitest。 */
const open: Array<{ client: DeviceClient; relay: MockRelay }> = [];
const extraRelays: MockRelay[] = [];

afterEach(async () => {
  for (const { client, relay } of open) {
    client.close();
    await relay.close();
  }
  open.length = 0;
  for (const relay of extraRelays) await relay.close();
  extraRelays.length = 0;
});

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 装配：mock relay + DeviceClient + MechaSession 接线（T16 daemon 的雏形）──

interface Stack {
  ws: string;
  policy: Mecha.MechaPolicy;
  session: MechaSession;
  client: DeviceClient;
  relay: MockRelay;
  /** onLinkChange 事件序列（断链/重连断言的数据源）。 */
  linkEvents: boolean[];
  attached: Mecha.CapabilityManifest[];
  ended: MechaSessionEndEvent[];
  opResults: Mecha.MechaOpResult[];
  chunks: Mecha.MechaExecChunk[];
  confirms: Mecha.MechaConfirmRequest[];
}

async function makeStack(opts?: {
  /** 心跳间隔覆盖（默认 30s——短测试窗口内永不触发）。 */
  heartbeatMs?: number;
  /** 确认挂起模式：confirm 回调发 confirmRequest 上行后挂起，由
   * wire.confirmResult 的下行批复解锁（T16 确认回路的接线雏形）。 */
  holdConfirm?: boolean;
}): Promise<Stack> {
  const ws = makeWorkspace('mecha-dc-');
  const policy: Mecha.MechaPolicy = {
    dirs: [ws],
    programs: [],
    limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
  };
  /** holdConfirm 模式的挂起确认（requestId → 解锁器）。 */
  const heldConfirms = new Map<string, (r: Mecha.MechaConfirmResult) => void>();
  const session = new MechaSession({
    provenance: new ProvenanceStore(join(ws, 'provenance.json')),
    confirm: (req) => {
      if (opts?.holdConfirm === true) {
        client.send({
          requestId: req.requestId,
          opId: req.opId,
          tier: req.tier,
          summary: req.summary,
        });
        return new Promise((resolve) => {
          heldConfirms.set(req.requestId, resolve);
        });
      }
      return Promise.resolve({ requestId: req.requestId, approved: true });
    },
    log: { logOp: () => {} },
  });
  const attached: Mecha.CapabilityManifest[] = [];
  const ended: MechaSessionEndEvent[] = [];
  session.on('attached', (m) => attached.push(m));
  session.on('ended', (e) => ended.push(e));

  const opResults: Mecha.MechaOpResult[] = [];
  const chunks: Mecha.MechaExecChunk[] = [];
  const confirms: Mecha.MechaConfirmRequest[] = [];
  const linkEvents: boolean[] = [];

  const relay = await startMockRelay(0);

  let currentSessionId: string | null = null;
  /** session.handleFrame 裁决 → accept/reject 帧回发（session.accept 需要
   * sessionId，从 offer 帧记下——pause/resume/end 帧不携带）。 */
  const route = (frame: Mecha.MechaDeviceFrame): void => {
    const d = session.handleFrame(frame);
    if (d === undefined) return;
    if (d.decision === 'accept') {
      client.send({ type: 'session.accept', sessionId: currentSessionId ?? '' });
    } else {
      client.send({ type: 'session.reject', reason: d.reason });
    }
  };

  const client = new DeviceClient({
    url: relay.url,
    deviceId: 'mecha-test-001',
    mechaVersion: MECHA_PACKAGE_VERSION,
    ...(opts?.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    backoffMs: () => 50,
    onLinkChange: (up) => {
      linkEvents.push(up);
    },
    wire: {
      offer: (frame) => {
        currentSessionId = frame.sessionId;
        route(frame);
      },
      pause: route,
      resume: route,
      end: route,
      policyUpdate: route,
      op: (envelope) => {
        void session.executeOp(envelope).then((result) => client.send(result));
      },
      confirmResult: (msg) => {
        heldConfirms.get(msg.requestId)?.(msg);
      },
    },
  });
  session.on('ended', () => {
    currentSessionId = null;
  });

  relay.driver.onMechaMessage((msg) => {
    if ('ok' in msg) opResults.push(msg);
    else if ('stream' in msg) chunks.push(msg);
    else confirms.push(msg);
  });

  await client.connect();
  open.push({ client, relay });
  return {
    ws,
    policy,
    session,
    client,
    relay,
    linkEvents,
    attached,
    ended,
    opResults,
    chunks,
    confirms,
  };
}

/** 不回 heartbeat_ack 的哑服务器（判死路径专用——mock relay 必 ack）。 */
function startSilentServer(opts?: { welcome?: boolean }): Promise<{
  url: string;
  heartbeats: () => number;
  close(): Promise<void>;
}> {
  const welcome = opts?.welcome !== false;
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let heartbeatCount = 0;
  return new Promise((resolve, reject) => {
    wss.once('error', reject);
    wss.on('connection', (sock) => {
      if (welcome) {
        sock.send(
          JSON.stringify({ type: 'device.welcome', serverTime: new Date().toISOString() }),
        );
      }
      sock.on('message', (data) => {
        let msg: { type?: unknown };
        try {
          msg = JSON.parse(String(data)) as { type?: unknown };
        } catch {
          return;
        }
        if (msg.type === 'device.hello' && welcome) {
          sock.send(
            JSON.stringify({ type: 'device.welcome', serverTime: new Date().toISOString() }),
          );
        }
        if (msg.type === 'heartbeat') heartbeatCount += 1;
      });
    });
    wss.once('listening', () => {
      const addr = wss.address() as AddressInfo;
      resolve({
        url: `ws://127.0.0.1:${addr.port}`,
        heartbeats: () => heartbeatCount,
        close: () =>
          new Promise<void>((resolveClose) => {
            wss.close(() => resolveClose());
          }),
      });
    });
  });
}

// ── 用例 ───────────────────────────────────────────────────────────────────

describe('DeviceClient × mock relay（真实 socket）', () => {
  it('连接握手：hello → welcome，connect() 兑现', async () => {
    const stack = await makeStack();
    expect(stack.linkEvents).toEqual([true]);
    const hello = stack.relay.frameLog.find((f) => f.type === 'device.hello');
    expect(hello).toEqual({
      type: 'device.hello',
      deviceId: 'mecha-test-001',
      mechaVersion: MECHA_PACKAGE_VERSION,
    });
  });

  it('mock 下发 session.offer → 机甲回 session.accept（frameLog 断言）+ attach 事件', async () => {
    const stack = await makeStack();
    stack.relay.driver.offer(stack.policy, 'sess-1', 'driver-1');

    const accept = await stack.relay.driver.waitFor(
      () =>
        stack.relay.frameLog.find(
          (f) => f.type === 'session.accept' && f.sessionId === 'sess-1',
        ),
    );
    expect(accept.type).toBe('session.accept');
    expect(stack.attached).toHaveLength(1);
    expect(stack.attached[0]?.sessionId).toBe('sess-1');
    // frameLog 顺序：hello 先于 accept（生命周期帧全量有序记录）
    const types = stack.relay.frameLog.map((f) => f.type);
    expect(types.indexOf('device.hello')).toBeLessThan(
      types.indexOf('session.accept'),
    );
  });

  it('driver 发 fs.list op → 收到 opResult ok（R16 op 信封通道）', async () => {
    const stack = await makeStack();
    stack.relay.driver.offer(stack.policy, 'sess-1', 'driver-1');
    await stack.relay.driver.waitFor(() =>
      stack.relay.frameLog.some(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-1',
      )
        ? true
        : undefined,
    );
    fs.writeFileSync(join(stack.ws, 'a.txt'), 'hello');

    stack.relay.driver.sendOp({
      opId: 'op-1',
      sessionId: 'sess-1',
      op: { type: 'fs.list', path: '.', depth: 0 },
    });

    const result = await stack.relay.driver.waitFor(
      () => stack.opResults.find((r) => r.opId === 'op-1'),
    );
    expect(result.ok).toBe(true);
    const entries = result.value as Array<{ name: string }>;
    expect(entries.map((e) => e.name)).toContain('a.txt');
  });

  it('driver 回 confirmResult → 抵达 wire.confirmResult，pending 确认闭环（approve 放行 / deny 得 CONFIRM_DENIED）', async () => {
    const stack = await makeStack({ holdConfirm: true });
    stack.relay.driver.offer(stack.policy, 'sess-1', 'driver-1');
    await stack.relay.driver.waitFor(() =>
      stack.relay.frameLog.some(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-1',
      )
        ? true
        : undefined,
    );

    // T1 op（fs.write）：confirm 回调发 confirmRequest 上行后挂起
    stack.relay.driver.sendOp({
      opId: 'op-1',
      sessionId: 'sess-1',
      op: { type: 'fs.write', path: 'out.txt', content: 'hello', encoding: 'utf8' },
    });
    const req1 = await stack.relay.driver.waitFor(() =>
      stack.confirms.find((c) => c.opId === 'op-1'),
    );
    expect(req1.tier).toBe('T1');

    // 下行批复经 R16 形状分流抵达 wire.confirmResult → 挂起确认解锁放行
    stack.relay.driver.sendDown({ requestId: req1.requestId, approved: true });
    const r1 = await stack.relay.driver.waitFor(
      () => stack.opResults.find((r) => r.opId === 'op-1'),
    );
    expect(r1.ok).toBe(true);
    expect(fs.existsSync(join(stack.ws, 'out.txt'))).toBe(true);

    // deny 路径：approved:false → CONFIRM_DENIED（无 confirmEnd 标记的人拒口径）
    stack.relay.driver.sendOp({
      opId: 'op-2',
      sessionId: 'sess-1',
      op: { type: 'fs.write', path: 'no.txt', content: 'x', encoding: 'utf8' },
    });
    const req2 = await stack.relay.driver.waitFor(() =>
      stack.confirms.find((c) => c.opId === 'op-2'),
    );
    stack.relay.driver.sendDown({ requestId: req2.requestId, approved: false });
    const r2 = await stack.relay.driver.waitFor(
      () => stack.opResults.find((r) => r.opId === 'op-2'),
    );
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe(Mecha.MECHA_ERROR_CODES[2]); // CONFIRM_DENIED
    expect(fs.existsSync(join(stack.ws, 'no.txt'))).toBe(false);
  }, 15_000);

  it('坏下行帧 → client 回 error 帧并忽略（不炸链路）', async () => {
    const stack = await makeStack();
    stack.relay.driver.sendDown({ type: 'session.rename', sessionId: 'x' }); // 未知 type
    stack.relay.driver.sendDown('not-json{{{'); // 不可解析
    const errors = await stack.relay.driver.waitFor(() => {
      const errs = stack.relay.frameLog.filter((f) => f.type === 'error');
      return errs.length >= 2 ? errs : undefined;
    });
    expect(errors.length).toBe(2);
    expect(stack.linkEvents).toEqual([true]); // 链路不受坏帧影响
  });

  it('杀掉 server → onLinkChange(false) → 同端口重启 → 自动重连 onLinkChange(true)', async () => {
    const stack = await makeStack();
    const port = Number(new URL(stack.relay.url).port);
    expect(stack.linkEvents).toEqual([true]);

    await stack.relay.close(); // 杀掉 server
    await stack.relay.driver.waitFor(
      () => (stack.linkEvents.includes(false) ? true : undefined),
      3_000,
    );

    const relay2 = await startMockRelay(port); // 同端口重启
    extraRelays.push(relay2);
    const iFalse = stack.linkEvents.indexOf(false);
    await stack.relay.driver.waitFor(
      () => (stack.linkEvents[iFalse + 1] === true ? true : undefined),
      3_000,
    );
    expect(stack.linkEvents).toEqual([true, false, true]);
    // 重连后握手照常：新 relay 的 frameLog 里有新 hello（同一 deviceId）
    const hello2 = await relay2.driver.waitFor(() =>
      relay2.frameLog.find((f) => f.type === 'device.hello'),
    );
    expect(hello2.deviceId).toBe('mecha-test-001');
  }, 15_000);

  it('心跳按 30s 默认发送且被 ack 时链路稳定（heartbeatMs 覆盖加速验证）', async () => {
    const stack = await makeStack({ heartbeatMs: 30 });
    await stack.relay.driver.waitFor(() => {
      const beats = stack.relay.frameLog.filter((f) => f.type === 'heartbeat');
      return beats.length >= 4 ? beats : undefined;
    }, 3_000);
    // 4 次心跳若无 ack 早已判死（2 missed 即断）——无 false 即 ack 生效
    expect(stack.linkEvents).toEqual([true]);
  }, 15_000);

  it('连续 2 次心跳无 ack → 判死断链 → 自动重连（不挂真实 30s）', async () => {
    const silent = await startSilentServer(); // welcome 照常，heartbeat 永不 ack
    const ws = makeWorkspace('mecha-dc-silent-');
    const session = new MechaSession({
      provenance: new ProvenanceStore(join(ws, 'provenance.json')),
      confirm: async (req) => ({ requestId: req.requestId, approved: true }),
      log: { logOp: () => {} },
    });
    const linkEvents: boolean[] = [];
    const client = new DeviceClient({
      url: silent.url,
      deviceId: 'mecha-test-002',
      mechaVersion: MECHA_PACKAGE_VERSION,
      heartbeatMs: 30,
      backoffMs: () => 50,
      onLinkChange: (up) => {
        linkEvents.push(up);
      },
      wire: {
        offer: (frame) => {
          const d = session.handleFrame(frame);
          if (d?.decision === 'reject') client.send({ type: 'session.reject', reason: d.reason });
        },
        pause: () => {},
        resume: () => {},
        end: () => {},
        policyUpdate: () => {},
        op: () => {},
        confirmResult: () => {},
      },
    });
    try {
      await client.connect();
      expect(linkEvents).toEqual([true]);
      // 判死时序：t=30 发 hb1、t=60 hb2(miss=1)、t=90 hb3(miss=2 → 断)——
      // 至少 3 次心跳后链路必须已断过
      await waitFor(() => (silent.heartbeats() >= 3 ? true : undefined), 3_000);
      const iFalse = await waitFor(() => {
        const i = linkEvents.indexOf(false);
        return i >= 0 ? i : undefined;
      }, 3_000);
      // 重连成功（silent 服务器照样 welcome）→ linkUp 再度翻转
      await waitFor(
        () => (linkEvents[iFalse + 1] === true ? true : undefined),
        3_000,
      );
    } finally {
      client.close();
      await silent.close();
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }, 15_000);

  it('welcome 超时 → connect() 拒绝（默认 10s，测试注入短超时）', async () => {
    const silent = await startSilentServer({ welcome: false }); // 收 hello 不回 welcome
    const client = new DeviceClient({
      url: silent.url,
      deviceId: 'mecha-test-003',
      mechaVersion: MECHA_PACKAGE_VERSION,
      welcomeTimeoutMs: 100,
      backoffMs: () => 50,
      wire: {
        offer: () => {},
        pause: () => {},
        resume: () => {},
        end: () => {},
        policyUpdate: () => {},
        op: () => {},
        confirmResult: () => {},
      },
    });
    try {
      await expect(client.connect()).rejects.toThrow(/welcome/);
    } finally {
      client.close();
      await silent.close();
    }
  }, 15_000);
});
