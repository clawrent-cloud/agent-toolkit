import WebSocket, { type RawData } from 'ws';
import { Mecha } from '@clawrent/protocol';
import type {
  MechaPolicyUpdateFrame,
  MechaSessionEndFrame,
  MechaSessionOfferFrame,
  MechaSessionPauseFrame,
  MechaSessionResumeFrame,
} from './session.js';

/**
 * 机甲设备客户端（plan Task 14）：机甲守护进程 ↔ 平台之间**同一条**出站
 * WebSocket 的哑管道。只连不监听（出站单向）、不拥有会话——session 逻辑
 * 全归 Task 12 状态机 / Task 16 daemon，本类只负责：
 *
 *  1. 连接握手：open → 发 `device.hello`{deviceId, mechaVersion, token?}
 *     （token 为 T17 设备令牌，注入才携带）→ 等
 *     `device.welcome`（默认 10s 超时 → 本次 connect() 失败；链路由后台
 *     重连继续接管）→ connect() 兑现；
 *  2. 心跳：每 heartbeatMs（默认 spec §11 的 30s）发 `heartbeat`，服务端
 *     约定回 `heartbeat_ack`；连续 2 次心跳无 ack → 链路判死（硬断，走
 *     统一的 close 路径）；
 *  3. 收发分流（Ruling R16，binding）：设备通道同载两族消息——
 *     - MechaDeviceFrame（JSON 带 `type` 判别）；
 *     - mecha op 信封（`opId`+`op` 字段的对象）。
 *     按**形状**分流三族：`'op' in msg && 'opId' in msg` → op 信封 →
 *     wire.op；`'requestId' in msg && 'approved' in msg` → 确认批复 →
 *     wire.confirmResult；否则按 MechaDeviceFrameSchema 解析分派到对应
 *     wire 回调。形状命中但 schema 不过 / 全不命中 / 不可解析 → 回
 *     `error` 帧并忽略（绝不炸链路）；
 *  4. 断链与重连：任何 close/error → onLinkChange(false)（仅状态翻转时
 *     通知）→ 指数退避重连（1s, 2s, 4s… 封顶 30s；backoffMs 可注入覆盖，
 *     测试用）→ 永久重试直至 close()。重连成功（welcome 再次到手）→
 *     onLinkChange(true)——daemon 据此调 session.markLinkUp/markLinkDown
 *     （T12 失电保护的触发器）。
 *
 * close()：停全部计时器、关 socket、不再重连。重连成功会清退避计数——
 * 长稳链路上的偶发抖动永远从 1s 重新爬坡，不会累计到 30s 封顶。
 */

/** wire 回调集：session 侧对下行帧的处置入口（T12 handleFrame / T16 接线）。
 * 回调抛错被吞（坏回调绝不炸客户端——session 事件表同口径）。帧精确类型
 * 复用 session.ts 的 Extract 别名（T12 单一定义，type-only 引用零运行时耦合）。 */
export interface DeviceClientWire {
  offer(frame: MechaSessionOfferFrame): void;
  pause(frame: MechaSessionPauseFrame): void;
  resume(frame: MechaSessionResumeFrame): void;
  end(frame: MechaSessionEndFrame): void;
  policyUpdate(frame: MechaPolicyUpdateFrame): void;
  op(envelope: Mecha.MechaOpEnvelope): void;
  /** 驾驶员对 mecha.confirmRequest 的批复下行（R16 确认回路闭环——缺此
   * 回调 confirmRequest 发出后永远无答）。 */
  confirmResult(msg: Mecha.MechaConfirmResult): void;
}

/** 设备通道上行载荷（R16 同通道双族）：设备帧（hello/heartbeat/accept/
 * reject）+ op 侧上行（opResult/execChunk/confirmRequest——session 执行
 * 产物经中继转发给驾驶员）。send 的参数类型。 */
export type MechaUplinkMessage =
  | Mecha.MechaDeviceFrame
  | Mecha.MechaOpResult
  | Mecha.MechaExecChunk
  | Mecha.MechaConfirmRequest;

/** 设备通道下行载荷（R16 同通道双族 + 确认批复）：设备帧、op 信封、驾驶员
 * 对确认请求的批复。收包分流的三族形状（client 内部按形状判别后走各自的
 * schema 解析）。 */
export type MechaDownlinkMessage =
  | Mecha.MechaDeviceFrame
  | Mecha.MechaOpEnvelope
  | Mecha.MechaConfirmResult;

export interface DeviceClientOpts {
  /** 平台设备通道 ws 地址（出站单向，client 只连不监听）。 */
  url: string;
  deviceId: string;
  mechaVersion: string;
  /** 设备令牌（T17 device flow 取得，daemon 从 config.deviceToken 传入）。
   * 提供时随 `device.hello` 上行；缺省 hello 不带 token 字段（additive 兼容）。 */
  token?: string;
  wire: DeviceClientWire;
  /** 链路状态翻转回调（false→true / true→false 才通知；初始即断不通知）。 */
  onLinkChange?: (up: boolean) => void;
  /** 重连退避注入（attempt 从 1 起）。缺省 1s,2s,4s… 封顶 30s。测试注入
   * 短值（如 () => 50）避免真实等待。 */
  backoffMs?: (attempt: number) => number;
  /** 心跳间隔 ms（缺省 spec §11 heartbeatMs = 30_000）。测试/特殊部署覆盖。 */
  heartbeatMs?: number;
  /** welcome 握手超时 ms（缺省 10_000）。测试注入短值。 */
  welcomeTimeoutMs?: number;
}

/** spec §11 默认心跳间隔（30s，单一事实源）。 */
const DEFAULT_HEARTBEAT_MS = Mecha.MECHA_LIMITS_DEFAULTS.heartbeatMs;
/** welcome 握手超时（plan Task 14：10s 不见 welcome 即本次连接失败）。 */
const DEFAULT_WELCOME_TIMEOUT_MS = 10_000;
/** 指数退避封顶（plan Task 14 全局约束）。 */
const MAX_BACKOFF_MS = 30_000;

export class DeviceClient {
  private readonly url: string;
  private readonly deviceId: string;
  private readonly mechaVersion: string;
  private readonly token: string | undefined;
  private readonly wire: DeviceClientWire;
  private readonly onLinkChangeCb: ((up: boolean) => void) | undefined;
  private readonly backoffMsFn: ((attempt: number) => number) | undefined;
  private readonly heartbeatMs: number;
  private readonly welcomeTimeoutMs: number;

  /** 当前活动 socket（dial 期间即非空；close 事件统一清位）。 */
  private ws: WebSocket | null = null;
  /** close() 置位：停重连、停心跳，client 生命周期终结。 */
  private closed = false;
  /** 链路状态（welcome 到手 = up；close = down）。翻转才通知。 */
  private linkUp = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  /** 在途握手（welcome 归属裁决——迟到/重复 welcome 忽略）。 */
  private handshake: { ws: WebSocket; finish: (err: Error | null) => void } | null =
    null;
  /** connect() 的在途 promise（重复 connect 复用同一次拨号）。 */
  private connecting: Promise<void> | null = null;
  /** 挂等链路恢复的 connect() 调用方（重连窗口期不另起拨号，T16 Step 0）：
   * welcome 到手统一兑现，close() 统一拒绝。 */
  private readonly linkWaiters = new Set<{
    resolve: () => void;
    reject: (err: Error) => void;
  }>();
  /** 心跳 ack 账（连续 2 次无 ack 判死）。 */
  private awaitingAck = false;
  private missedAcks = 0;

  constructor(opts: DeviceClientOpts) {
    this.url = opts.url;
    this.deviceId = opts.deviceId;
    this.mechaVersion = opts.mechaVersion;
    this.token = opts.token;
    this.wire = opts.wire;
    this.onLinkChangeCb = opts.onLinkChange;
    this.backoffMsFn = opts.backoffMs;
    this.heartbeatMs = opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.welcomeTimeoutMs = opts.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS;
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  /**
   * 拨号并完成 hello/welcome 握手。首次失败（连接错误 / 10s 无 welcome）
   * → promise 拒绝；但重连循环已在后台接管（「服务未起」是守护进程开机
   * 的常态而非终局——拒绝只面向首调方的诊断面）。重复调用语义（竞态守卫，
   * T16 Step 0）：
   *  - 在途 initial 拨号 → 复用同一 promise（调用方同命运）；
   *  - 链路已就绪（welcome 到手）→ 兑现即返；
   *  - 重连机器在途（退避计时器挂起 / 后台拨号进行中 / 濒死 socket 未清场）
   *    → **不另起拨号**（否则与计时器触发的后台拨号构成双拨号竞态：两个
   *    socket 抢 this.ws、僵尸 socket 的 close 再驱动一轮重连），也不兑现
   *    （链路仍断）——挂等链路恢复：重连拨通（welcome 到手）即兑现，
   *    close() 则拒绝。
   * close() 后调用拒绝。
   */
  connect(): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error('DeviceClient.connect: client is closed'));
    }
    if (this.connecting !== null) return this.connecting;
    // 链路就绪的唯一判据是 linkUp（welcome 到手置位）——旧 `ws !== null`
    // 判据在「后台拨号已 resolve、socket 尚未走完 close 清场」的窗口会
    // 过早兑现（链路可能仍断）。
    if (this.linkUp) return Promise.resolve();
    if (this.reconnectTimer !== null || this.ws !== null) {
      return new Promise<void>((resolve, reject) => {
        this.linkWaiters.add({ resolve, reject });
      });
    }
    const dial = this.dial(true);
    this.connecting = dial;
    void dial
      .catch(() => {}) // 拒绝已交给返回值；此处只为清 connecting 的链不断
      .then(() => {
        if (this.connecting === dial) this.connecting = null;
      });
    return dial;
  }

  /** 上行一条消息（设备帧或 op 族上行，R16 双族同通道）。链路未就绪时
   * 静默丢弃——哑管道不缓存不重放，重发语义归上层。 */
  send(message: MechaUplinkMessage): void {
    this.sendRaw(message);
  }

  /** 终结：停计时器、关 socket、不再重连。幂等。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.settleLinkWaiters(false); // 挂等的 connect() 调用方以拒绝收场
    const ws = this.ws;
    this.ws = null;
    if (ws !== null) {
      try {
        ws.close(); // CONNECTING 态 = 中止握手；OPEN 态 = 发起关闭握手
      } catch {
        // 已死连接的关闭失败可忽略——'close' 事件兜底清场
      }
    }
  }

  // ── 拨号 ──────────────────────────────────────────────────────────────────

  /** 单次拨号（含 hello/welcome 握手）。initial=true 时失败拒绝（connect()
   * 的承诺）；后台重连拨号的失败经 resolve 静默吸收——重连调度统一归
   * socket 的 close 事件，本 promise 只做在途标记。 */
  private dial(initial: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      let settled = false;
      let welcomeTimer: NodeJS.Timeout | null = null;

      const finish = (err: Error | null): void => {
        if (settled) return;
        settled = true;
        if (welcomeTimer !== null) {
          clearTimeout(welcomeTimer);
          welcomeTimer = null;
        }
        if (this.handshake?.ws === ws) this.handshake = null;
        if (err !== null && initial) reject(err);
        else resolve();
      };
      this.handshake = { ws, finish };

      ws.on('open', () => {
        this.sendRaw({
          type: 'device.hello',
          deviceId: this.deviceId,
          mechaVersion: this.mechaVersion,
          // 设备鉴权（T17）：有令牌才带字段——协议帧 token optional，
          // 缺省不发，mock relay 等不带鉴权的测试替身不受影响。
          ...(this.token !== undefined ? { token: this.token } : {}),
        });
        welcomeTimer = setTimeout(() => {
          finish(new Error('DeviceClient: device.welcome timeout'));
          ws.terminate(); // 硬断；失链与重连统一由 'close' 事件收口
        }, this.welcomeTimeoutMs);
      });

      ws.on('message', (data) => {
        this.onMessage(data, ws, finish);
      });

      ws.on('error', () => {
        finish(new Error('DeviceClient: connection error'));
        // ws 契约：'error' 后必有 'close'——失链与重连在 close 统一处理
      });

      ws.on('close', () => {
        finish(
          initial ? new Error('DeviceClient: closed before device.welcome') : null,
        );
        if (this.ws === ws) this.ws = null;
        this.stopHeartbeat();
        const wasUp = this.linkUp;
        this.linkUp = false;
        if (wasUp) this.notifyLink(false);
        this.scheduleReconnect(); // close() 已置位时为 no-op
      });
    });
  }

  // ── 收包分流（R16 双族同通道）────────────────────────────────────────────

  private onMessage(
    data: RawData,
    ws: WebSocket,
    finish: (err: Error | null) => void,
  ): void {
    let msg: unknown;
    try {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString('utf8')
        : data.toString();
      msg = JSON.parse(text) as unknown;
    } catch {
      this.sendRaw({
        type: 'error',
        code: 'bad_frame',
        message: 'unparseable message on device channel',
      });
      return;
    }

    // 形状分流（R16）：op 信封（'op'+'opId'）与确认批复（'requestId'+
    // 'approved'）优先于设备帧（'type' 判别）——设备帧不带这几类键，判别
    // 互斥。
    if (typeof msg === 'object' && msg !== null) {
      if ('op' in msg && 'opId' in msg) {
        const parsed = Mecha.MechaOpEnvelopeSchema.safeParse(msg);
        if (!parsed.success) {
          this.sendRaw({
            type: 'error',
            code: 'bad_frame',
            message: 'invalid op envelope',
          });
          return;
        }
        this.safeWire(() => this.wire.op(parsed.data));
        return;
      }
      if ('requestId' in msg && 'approved' in msg) {
        const parsed = Mecha.MechaConfirmResultSchema.safeParse(msg);
        if (!parsed.success) {
          this.sendRaw({
            type: 'error',
            code: 'bad_frame',
            message: 'invalid confirm result',
          });
          return;
        }
        this.safeWire(() => this.wire.confirmResult(parsed.data));
        return;
      }
    }

    const parsed = Mecha.MechaDeviceFrameSchema.safeParse(msg);
    if (!parsed.success) {
      this.sendRaw({
        type: 'error',
        code: 'bad_frame',
        message: 'invalid device frame',
      });
      return;
    }
    const frame = parsed.data;
    switch (frame.type) {
      case 'device.welcome':
        this.handleWelcome(ws, finish);
        return;
      case 'heartbeat_ack':
        this.awaitingAck = false;
        this.missedAcks = 0;
        return;
      case 'session.offer':
        this.safeWire(() => this.wire.offer(frame));
        return;
      case 'session.pause':
        this.safeWire(() => this.wire.pause(frame));
        return;
      case 'session.resume':
        this.safeWire(() => this.wire.resume(frame));
        return;
      case 'session.end':
        this.safeWire(() => this.wire.end(frame));
        return;
      case 'policy.update':
        this.safeWire(() => this.wire.policyUpdate(frame));
        return;
      default:
        // device.hello / heartbeat / session.accept / session.reject /
        // session.manifest / error：上行帧回声与通道级错误，client 不处置
        //（accept/reject/manifest 的产生与发送归 session/daemon 侧）。
        return;
    }
  }

  /** welcome 到手：握手收口 + 链路置 up + 心跳开表 + 通知。迟到/重复的
   * welcome（握手已完成）忽略。 */
  private handleWelcome(
    ws: WebSocket,
    finish: (err: Error | null) => void,
  ): void {
    if (this.handshake === null || this.handshake.ws !== ws) return;
    this.handshake = null;
    this.linkUp = true;
    this.reconnectAttempt = 0; // 长稳链路偶发抖动从 1s 重新爬坡
    this.settleLinkWaiters(true); // 挂等的 connect() 调用方随链路恢复兑现
    this.startHeartbeat();
    this.notifyLink(true);
    finish(null);
  }

  /** 统一收口挂等的 connect() 调用方（welcome → 兑现；close → 拒绝）。 */
  private settleLinkWaiters(up: boolean): void {
    if (this.linkWaiters.size === 0) return;
    const waiters = [...this.linkWaiters];
    this.linkWaiters.clear();
    for (const waiter of waiters) {
      if (up) waiter.resolve();
      else waiter.reject(new Error('DeviceClient.connect: client is closed'));
    }
  }

  // ── 心跳（2 missed ack 判死）──────────────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.awaitingAck) {
        this.missedAcks += 1;
        if (this.missedAcks >= 2) {
          // 连续 2 次心跳无 ack → 链路判死：硬断，'close' 统一走失链+重连
          this.ws?.terminate();
          return;
        }
      }
      this.awaitingAck = true;
      this.sendRaw({ type: 'heartbeat' });
    }, this.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.awaitingAck = false;
    this.missedAcks = 0;
  }

  // ── 重连（指数退避，永续直至 close）──────────────────────────────────────

  private scheduleReconnect(): void {
    if (this.closed) return;
    // 竞态守卫（T16 Step 0）：旧计时器先撤再排新——两个 socket 的 close 相继
    // 触发本函数时，覆写不清理会留下双计时器 → 双拨号 → 双活连接。
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const attempt = this.reconnectAttempt + 1;
    this.reconnectAttempt = attempt;
    const delay =
      this.backoffMsFn !== undefined
        ? this.backoffMsFn(attempt)
        : Math.min(1000 * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      void this.dial(false).catch(() => {
        // 后台拨号失败已在 dial 内 resolve 吸收；此处兜底防未处理拒绝
      });
    }, delay);
  }

  // ── 发包与通知（尽力而为，坏回调不炸管道）────────────────────────────────

  private sendRaw(payload: unknown): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return; // 链路未就绪：丢弃
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // 发送失败交 'close' 事件裁决（socket 已死时 close 必至）
    }
  }

  private notifyLink(up: boolean): void {
    if (this.onLinkChangeCb === undefined) return;
    try {
      this.onLinkChangeCb(up);
    } catch {
      // 回调故障不炸重连循环
    }
  }

  private safeWire(fn: () => void): void {
    try {
      fn();
    } catch {
      // wire 回调故障不炸客户端（session/daemon 侧健壮性归各层）
    }
  }
}
