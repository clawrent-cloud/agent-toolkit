import { WebSocketServer, WebSocket, type RawData } from 'ws';
import type { AddressInfo } from 'node:net';
import { Mecha } from '@clawrent/protocol';
import type { MechaPolicyUpdateFrame } from '../src/session.js';

/**
 * mock 中继（plan Task 14）：平台设备通道契约的测试替身。Task 16（daemon
 * 总装）与 Task 24（端到端计费断言）共用。真实 127.0.0.1 socket，无 mock
 * 时间——行为断言一律 poll（waitFor），绝不真实 sleep。
 *
 * 平台侧契约（本替身实现的最小面）：
 *  - 机甲连入 → 等 `device.hello` → 回 `device.welcome`{serverTime}；
 *  - `heartbeat` → `heartbeat_ack`（回声）；
 *  - driver 侧（测试）可向机甲下发全部下行设备帧（offer/pause/resume/end/
 *    policy.update）与 R16 op 信封；
 *  - 机甲上行的**全部设备帧**（hello/accept/reject/heartbeat/end/error…）
 *    按序记入 `frameLog`——T24 计费口径断言的数据源；
 *  - 机甲上行的 op 族消息（opResult/execChunk/confirmRequest，R16 双族的
 *    另一半）不进 frameLog，经 `driver.onMechaMessage` 交给测试。
 *
 * 单设备位（latest-wins）：新连接接管设备位、旧连接即僵尸被 terminate——
 * 重连测试里旧 socket 的残帧不会污染 frameLog 时序。
 */

/** driver 侧能收到的机甲上行（op 族，R16 双族的另一半）。 */
export type DriverInbound =
  | Mecha.MechaOpResult
  | Mecha.MechaExecChunk
  | Mecha.MechaConfirmRequest;

/** 测试句柄：向机甲下发帧/op、订阅机甲上行、poll 等待。 */
export interface FakeDriver {
  /** 下发 session.offer（orderRef 自动生成，expiresAt 5 分钟）。 */
  offer(
    policy: Mecha.MechaPolicy,
    sessionId: string,
    driverAgentId: string,
  ): void;
  pause(): void;
  resume(): void;
  end(reason: Mecha.MechaSessionEndReason): void;
  /** 下发 policy.update（帧由测试构造——含「expand 缺 authorizationRef」
   * 的非法形态注入）。 */
  policyUpdate(frame: MechaPolicyUpdateFrame): void;
  /** 下发 R16 op 信封（opId/sessionId/op）。 */
  sendOp(envelope: Mecha.MechaOpEnvelope): void;
  /** 原始下行注入（坏帧/不可解析报文/后续任务的 confirmResult 等测试面）。 */
  sendDown(msg: unknown): void;
  /** 订阅机甲上行 op 族消息；返回退订函数。 */
  onMechaMessage(cb: (msg: DriverInbound) => void): () => void;
  /** poll 谓词直至真值或超时（绝不真实 sleep 等待——10ms 轮询）。 */
  waitFor<T>(
    predicate: () => T | undefined | null | false,
    timeoutMs?: number,
  ): Promise<T>;
}

/** startMockRelay 的返回：ws server 句柄 + 机甲上行帧序 + driver 测试句柄。 */
export interface MockRelay {
  server: WebSocketServer;
  /** `ws://127.0.0.1:<port>`（port=0 时为实际回读端口）。 */
  url: string;
  /** 机甲上行的全部设备帧（按序——T24 计费断言的数据源）。 */
  frameLog: Mecha.MechaDeviceFrame[];
  driver: FakeDriver;
  /** 停服：断开全部连接并等待 server 关闭（同端口重启测试的先决）。 */
  close(): Promise<void>;
}

/** poll 等待（10ms 间隔）：谓词返回真值即兑现，超时抛错。 */
export async function waitFor<T>(
  predicate: () => T | undefined | null | false,
  timeoutMs = 5_000,
  intervalMs = 10,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) {
      throw new Error(`mock relay waitFor: timeout after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function textOf(data: RawData): string {
  return Array.isArray(data)
    ? Buffer.concat(data).toString('utf8')
    : data.toString();
}

/**
 * 启动 mock 中继。port=0 → 内核分配临时端口（`url` 回读实际端口）；
 * 测试杀掉重启时对同一数字端口再次调用即可（DeviceClient 的重连会拨回来）。
 */
export async function startMockRelay(port = 0): Promise<MockRelay> {
  const frameLog: Mecha.MechaDeviceFrame[] = [];
  const driverCbs = new Set<(msg: DriverInbound) => void>();
  /** 当前设备位（latest-wins；null = 无机甲在线）。 */
  let mecha: WebSocket | null = null;

  const emit = (msg: DriverInbound): void => {
    for (const cb of driverCbs) {
      try {
        cb(msg);
      } catch {
        // 测试回调故障不炸中继
      }
    }
  };

  const sendDown = (msg: unknown): void => {
    const sock = mecha;
    if (sock === null || sock.readyState !== WebSocket.OPEN) return; // 无机甲在线：丢弃
    sock.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  };

  /** 机甲上行分流（R16 双族）：设备帧 → frameLog + 平台契约应答；
   * op 族 → driver 回调；皆非 → error 帧回敬。 */
  const onMechaFrame = (data: RawData): void => {
    let msg: unknown;
    try {
      msg = JSON.parse(textOf(data)) as unknown;
    } catch {
      sendDown({
        type: 'error',
        code: 'bad_frame',
        message: 'mock relay: unparseable uplink',
      });
      return;
    }
    const frame = Mecha.MechaDeviceFrameSchema.safeParse(msg);
    if (frame.success) {
      frameLog.push(frame.data);
      if (frame.data.type === 'device.hello') {
        sendDown({
          type: 'device.welcome',
          serverTime: new Date().toISOString(),
        });
      } else if (frame.data.type === 'heartbeat') {
        sendDown({ type: 'heartbeat_ack' });
      }
      return;
    }
    const result = Mecha.MechaOpResultSchema.safeParse(msg);
    if (result.success) {
      emit(result.data);
      return;
    }
    const chunk = Mecha.MechaExecChunkSchema.safeParse(msg);
    if (chunk.success) {
      emit(chunk.data);
      return;
    }
    const confirm = Mecha.MechaConfirmRequestSchema.safeParse(msg);
    if (confirm.success) {
      emit(confirm.data);
      return;
    }
    sendDown({
      type: 'error',
      code: 'bad_frame',
      message: 'mock relay: unrecognized uplink',
    });
  };

  const wss = new WebSocketServer({ port, host: '127.0.0.1' });
  await new Promise<void>((resolve, reject) => {
    wss.once('listening', () => resolve());
    wss.once('error', reject);
  });

  wss.on('connection', (sock) => {
    // latest-wins：重连场景旧连接是僵尸，terminate 防残帧污染 frameLog
    if (mecha !== null && mecha !== sock) {
      try {
        mecha.terminate();
      } catch {
        // 僵尸清理尽力而为
      }
    }
    mecha = sock;
    sock.on('message', (data) => onMechaFrame(data));
    sock.on('close', () => {
      if (mecha === sock) mecha = null;
    });
  });

  let orderSeq = 0;
  const driver: FakeDriver = {
    offer(policy, sessionId, driverAgentId) {
      orderSeq += 1;
      sendDown({
        type: 'session.offer',
        sessionId,
        orderRef: `order-${orderSeq}`,
        driverAgentId,
        policy,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      });
    },
    pause() {
      sendDown({ type: 'session.pause' });
    },
    resume() {
      sendDown({ type: 'session.resume' });
    },
    end(reason) {
      sendDown({ type: 'session.end', reason });
    },
    policyUpdate(frame) {
      sendDown(frame);
    },
    sendOp(envelope) {
      sendDown(envelope);
    },
    sendDown,
    onMechaMessage(cb) {
      driverCbs.add(cb);
      return () => {
        driverCbs.delete(cb);
      };
    },
    waitFor,
  };

  const addr = wss.address() as AddressInfo;
  return {
    server: wss,
    url: `ws://127.0.0.1:${addr.port}`,
    frameLog,
    driver,
    close: () =>
      new Promise<void>((resolve) => {
        driverCbs.clear();
        const sock = mecha;
        mecha = null;
        if (sock !== null) {
          try {
            sock.terminate(); // 硬断：server.close 不等关闭握手，回程快
          } catch {
            // 尽力而为
          }
        }
        wss.close(() => resolve());
      }),
  };
}
