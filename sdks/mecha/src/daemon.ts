import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { MECHA_PACKAGE_VERSION, mechaHome } from './constants.js';
import { DeviceClient } from './device-client.js';
import { DashcamLogger } from './logging.js';
import { IpcServer, safeIpcName } from './ipc.js';
import {
  MechaSession,
  type MechaConfirmSettlementOutcome,
  type MechaPolicyUpdateFrame,
  type MechaSessionEndEvent,
  type MechaSessionOfferFrame,
} from './session.js';
import type { MechaConfirmSettlement } from './ops/executor.js';
import { ProvenanceStore } from './enforcement/provenance.js';

/**
 * 机甲守护进程总装（plan Task 16）：把 device-client（T14）+ session 状态机
 * （T12）+ executor（T10/11，经 session 装配）+ 行车记录（T13）+ 本地 IPC
 * （T15）接成一台可运行的机甲。本模块**只接线不重实现**——断链失电、确认
 * 超时/取消、即焚、独占等语义全部内建在部件里，daemon 职责面：
 *
 *  1. 配置装载：读 config.json（T18 setup 落盘的 deviceId/deviceToken/
 *     apiBase/profile 四字段）。缺文件/坏形状一律响亮拒绝（「请先运行
 *     mecha setup」）——守护进程不带病空转。deviceToken（T17 device flow
 *     取得）经 DeviceClient 随 `device.hello` 上行（协议帧 token 为
 *     optional additive 字段，平台侧鉴权消费见 spec §7.7）。
 *  2. 部件装配（每 daemon 恰一套，R6 单例裁定）：ProvenanceStore ONE per
 *     daemon（跨会话判红的红链是安全资产，即焚不清）；DashcamLogger
 *     （logs/ 目录自建）；DeviceClient（设备通道 ws，relayUrl 覆盖或按
 *     deriveRelayUrl(apiBase) 换算）；IpcServer（safeIpcName(profile)，
 *     同机多实例门 A8）。
 *  3. 会话所有权：daemon 持至多一个 MechaSession（A7 独占由 session 兜底，
 *     第二 offer → reject 'busy'）。wire 回调一线一义：
 *     offer → session.offer 裁决 → accept/reject 帧回发；pause/resume →
 *     session.pause()/resume() + lifecycle 落账；end → disarm(reason)；
 *     policy.update → session.policyUpdate + 回执；op → executeOp →
 *     opResult 上行；confirmResult → 确认回路解锁。
 *  4. 确认回路（daemon 只桥接）：session 的原始 confirm 回调把
 *     `mecha.confirmRequest` 上行并挂起等 wire.confirmResult 的下行批复——
 *     超时默认拒（300s）/断链收割语义内建在 session 包装层（T12），daemon
 *     不重实现。结算与审计一对一归真（T16 fix）：司机批复落地 →
 *     logConfirm(批复)；会话先收割（timeout/link_down/ended 的
 *     onConfirmSettled 通知）→ logConfirm(真实结算)；两路都以「摘表项」为
 *     第一动作——迟到的批复扑空即静默，绝不写出与事实不符的第二笔账。
 *  5. 链路事件 → 失电保护：onLinkChange(false) → markLinkDown（杀 exec +
 *     收割确认 + 宽限计时）+ 'link_down' 落账；onLinkChange(true) →
 *     markLinkUp 的 'resumed' | 'grace_expired' 裁决落账。
 *  6. 行车记录接线（T13 约束）：'attached' → beginSession(manifest)；
 *     'ended' → endSession(reason)（session_end 恒末行 + 关 fd）；
 *     paused/resumed/link_down/consumer_halt/grace_expired → logLifecycle。
 *     **守卫**：无在会话一律不落账（logConfirm/logPolicyUpdate/logLifecycle
 *     落「当前会话」，空会话落账即抛——审计优先的响亮面由 daemon 的闸位
 *     表达为「无会话即无账可落」，绝不让审计异常炸链路）。
 *  7. 本地 IPC（T15 纪律：handler 同步返回）：status() 从 session 态 +
 *     daemon 跟踪面（sessionId/driverAgentId/since/activeOp）拼快照；
 *     halt() = logLifecycle('consumer_halt')（须在合卷前）+ disarm
 *     ('consumer_halt')（幂等：无会话即无事可刹）。
 *  8. stop()：在会终局（'platform'）→ 断设备通道（停重连/心跳，挂等的
 *     connect() 以拒绝收场）→ 关 IPC。幂等；返回即无悬挂计时器。
 *  9. 即焚的崩溃兜底——惰性孤儿清扫（I2 fix，final review）：scratch 的
 *     删除点在会话终局（session.teardown），daemon 崩溃/被杀时该点不达，
 *     scratch 残留为孤儿。开机即扫不可行（daemon 只在 offer 时才知道白名
 *     单根），故惰性执行：daemon 记开机时刻，每次会话终局（'ended'）后
 *     清扫本会话 scratch 根（首白名单目录 .clawrent/scratch/）下 mtime 早
 *     于开机时刻的 sibling 目录——上次崩溃运行的孤儿必然早于本 daemon 开
 *     机，首次会话终局即被清；开机后新建的目录（活跃会话在用）一律不碰。
 *     清扫是卫生性动作：单目录失败吞掉留待下次，不阻断终局链。
 */

/** 守护进程配置（config.json 形状 = T18 setup 落盘契约）。 */
export interface MechaDaemonConfig {
  deviceId: string;
  /** 设备令牌（T17 device flow 取得），随 device.hello 上行（设备鉴权）。 */
  deviceToken: string;
  /** 平台 API base（relayUrl 缺省时按 deriveRelayUrl 换算设备通道地址）。 */
  apiBase: string;
  /** 实例 profile（IPC 端点名构成件，同机多实例门）。 */
  profile: string;
}

/** startDaemon 选项。 */
export interface StartDaemonOpts {
  /** 守护进程配置文件路径（T18 setup 落盘；缺文件即「请先运行 mecha setup」）。 */
  configPath: string;
  /** 设备通道 ws 地址覆盖。缺省按 config.apiBase 换算（见 deriveRelayUrl）。 */
  relayUrl?: string;
  /** 机甲根目录覆盖（R17 裁定，**test-only**）：logs/ 与 provenance.json 由此
   * 派生。缺省 mechaHome()。 */
  homeOverride?: string;
}

/** 守护进程句柄：唯一操作面是优雅停机。 */
export interface DaemonHandle {
  /** 优雅停机（幂等）：在会终局（'platform'）→ 断设备通道 → 关 IPC。 */
  stop(): Promise<void>;
}

/** 确认回路的桥接表项（T16 fix）：req 复记供会话收割时补写真实结算对。 */
interface PendingConfirmBridge {
  req: Mecha.MechaConfirmRequest;
  resolve: (result: Mecha.MechaConfirmResult) => void;
}

/** 会话侧收割的真实结算（T16 fix）：审计对与本地 promise 兜底值的单一来源
 * ——confirmEnd 与 session 实际裁定一致（timeout/link_down/ended），迟到
 * 批复到达时表项已摘、此值不再被任何执行面消费。 */
function harvestedSettlement(
  requestId: string,
  outcome: MechaConfirmSettlementOutcome,
): MechaConfirmSettlement {
  switch (outcome) {
    case 'timeout':
      return { requestId, approved: false, confirmEnd: 'timeout' };
    case 'link_down':
      return { requestId, approved: false, confirmEnd: 'link_down' };
    case 'ended':
      return { requestId, approved: false, confirmEnd: 'ended' };
    case 'approved':
    case 'denied':
      // 司机批复在时效内落地时表项已由 confirmResult 先摘，此二值不可达
      // ——防御性兜底（口径与批复一致）。
      return { requestId, approved: outcome === 'approved' };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * 惰性孤儿清扫（I2 fix，见文件头规则 9）：遍历 scratch 根下的目录条目，
 * mtime 早于 `startedAtMs`（本 daemon 开机时刻）的按即焚口径递归删除——
 * 崩溃残留的孤儿 scratch 必然早于本 daemon 开机；开机后新建的目录（活跃
 * 会话在用/新会话刚建）一律不碰。根不可读 = 无可清扫；单目录失败留待下
 * 次终局重试（卫生性动作，绝不炸终局链）。
 */
function sweepOrphanScratch(root: string | null, startedAtMs: number): void {
  if (root === null) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // 根不存在/不可读：无可清扫
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    try {
      if (fs.statSync(dir).mtimeMs >= startedAtMs) continue; // 开机后的目录不碰
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // 卫生性动作：失败留待下次终局重试
    }
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * 装载并校验守护进程配置。缺文件 → 「请先运行 mecha setup」；坏 JSON /
 * 四字段任缺非空串 → 各自响亮拒绝（守护进程绝不带病空转）。
 */
export function loadDaemonConfig(configPath: string): MechaDaemonConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (isEnoent(err)) {
      throw new Error(`机甲配置不存在（${configPath}）：请先运行 mecha setup`, {
        cause: err,
      });
    }
    throw new Error(`机甲配置不可读（${configPath}）: ${errMsg(err)}`, {
      cause: err,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`机甲配置不是合法 JSON（${configPath}）: ${errMsg(err)}`, {
      cause: err,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`机甲配置形状非法（${configPath}）：应为 JSON 对象`);
  }
  const rec = parsed as Record<string, unknown>;
  for (const field of ['deviceId', 'deviceToken', 'apiBase', 'profile'] as const) {
    const value = rec[field];
    if (typeof value !== 'string' || value === '') {
      throw new Error(
        `机甲配置字段 ${field} 缺失或非法（${configPath}）：请先运行 mecha setup`,
      );
    }
  }
  // apiBase 协议门（T16 fix Minor）：非 http(s) 的 apiBase 经 deriveRelayUrl
  // 会产出非法 ws 地址——DeviceClient 首拨同步抛错、重连链就此死亡（一次
  // warn 后静默空转）。开机即响亮拒绝，不带病启动。
  const apiBase = rec['apiBase'] as string;
  if (!/^https?:\/\//i.test(apiBase)) {
    throw new Error(
      `机甲配置 apiBase 须为 http(s):// 地址（收到 ${JSON.stringify(apiBase)}）：请先运行 mecha setup`,
    );
  }
  return {
    deviceId: rec['deviceId'] as string,
    deviceToken: rec['deviceToken'] as string,
    apiBase,
    profile: rec['profile'] as string,
  };
}

/**
 * apiBase → 设备通道 ws 地址的换算规则（T16 钉死）：`https://` → `wss://`、
 * `http://` → `ws://`（已 ws/wss 开头原样保留），去尾斜杠后拼 `/ws/mecha`。
 * 例：`https://api.clawrent.cloud` → `wss://api.clawrent.cloud/ws/mecha`。
 */
export function deriveRelayUrl(apiBase: string): string {
  let url = apiBase.trim();
  if (/^https:\/\//i.test(url)) url = `wss://${url.slice(8)}`;
  else if (/^http:\/\//i.test(url)) url = `ws://${url.slice(7)}`;
  url = url.replace(/\/+$/, '');
  return `${url}/ws/mecha`;
}

/**
 * 总装并启动守护进程。返回前 IPC 已监听（可 status/halt）；设备通道首连
 * 不阻断开机（「服务未起」是常态——DeviceClient 的后台重连循环接管，首连
 * 失败仅作诊断输出）。op 帧经 confirm-tier 判级：T0 直执行；T1/T2 发
 * `mecha.confirmRequest` 等驾驶员（生产为平台转发的消费者网页）批复，结果
 * 以 `mecha.opResult` 回。
 */
export async function startDaemon(opts: StartDaemonOpts): Promise<DaemonHandle> {
  const config = loadDaemonConfig(opts.configPath);
  const home = opts.homeOverride ?? mechaHome();
  // R6：ProvenanceStore 每 daemon 恰一个（跨会话判红的红链是安全资产——
  // 即焚不清此表，会话更替共用同一红链）。
  const provenance = new ProvenanceStore(join(home, 'provenance.json'));
  const logger = new DashcamLogger(join(home, 'logs'));

  // ── daemon 跟踪面（IPC status 快照的数据源；session 态以 session.state 为准）──
  let currentSessionId: string | null = null;
  let driverAgentId: string | null = null;
  let activeOp: string | null = null;
  let since = Date.now();
  // I2 惰性清扫口径：开机时刻 + 最近一个在会会话的 scratch 根（'attached'
  // 时从 manifest 记下——daemon 只在 offer 时才知道白名单根；'ended' 时用）。
  const startedAtMs = Date.now();
  let endedScratchRoot: string | null = null;

  /** 确认回路桥（requestId → 桥接表项）。表项存在 = 司机批复未落地：
   * 会话侧收割（onConfirmSettled）与司机批复（confirmResult）双方都以
   * 「摘表项」为第一动作——后到者扑空即静默忽略（T16 fix：迟到批复绝不
   * 写出与事实不符的第二笔账）。 */
  const pendingConfirms = new Map<string, PendingConfirmBridge>();

  /** 生命周期落账闸（T13 约束）：无在会话一律跳过——logger 的落「当前会话」
   * 面对空会话是响亮抛错（审计优先），daemon 以闸位表达「无会话即无账可落」，
   * 绝不让空闲期的链路事件炸穿审计面。 */
  const logLifecycle = (event: string, detail?: unknown): void => {
    if (currentSessionId === null) return;
    logger.logLifecycle(event, detail);
  };

  // ── 会话状态机（至多一个在会，A7 独占由 session 兜底）─────────────────────
  const session = new MechaSession({
    provenance,
    // 确认回路（daemon 只桥接）：request 上行 → 挂等下行批复。超时默认拒 /
    // 断链收割内建在 session 包装层——此处不重实现。审计一对一归真：司机
    // 批复由 confirmResult 入档；会话先收割（超时/断链/终局）由
    // onConfirmSettled 补记真实结算对——两路互斥（摘表项竞先，后到扑空）。
    confirm: (req) =>
      new Promise<Mecha.MechaConfirmResult>((resolve) => {
        pendingConfirms.set(req.requestId, { req, resolve });
        client.send(req); // mecha.confirmRequest 上行（生产由平台转发消费者网页）
      }),
    log: logger, // DashcamLogger 结构满足 ExecutorLogger（logOp 每 op 恰一次）
    // 会话级生命周期落账（I1/I3 fix）：错会话信封拒收行与 T1-remember 标记
    // 行经此入当前会话日志（闸位与下方 logLifecycle 同一口径：无会话不落）。
    logLifecycle: (event, detail) => logLifecycle(event, detail),
    onChunk: (chunk) => client.send(chunk), // exec.run 流块上行（哑管道，断链即弃）
    onPolicyUpdate: (frame, applied) => {
      // T13 约束：仅会话在位时落账——session 的该回调在 idle 拒绝时也会触发
      //（「全量记账」），而空会话落账会让 logger 抛。
      if (currentSessionId !== null) logger.logPolicyUpdate(frame, applied);
    },
    onConfirmSettled: (requestId, outcome) => {
      const entry = pendingConfirms.get(requestId);
      if (entry === undefined) return; // 司机批复已落地并如实入档——无残账
      pendingConfirms.delete(requestId);
      // 真实结算对入档（确认超时/断链/终局的审计真相——司机批复未到，
      // 此通知即结算事实的唯一来源）
      logger.logConfirm(entry.req, harvestedSettlement(requestId, outcome));
      // 本地 promise 收口（race 已被 session 结算，兜底值被执行侧丢弃——桥不悬挂）
      entry.resolve({ requestId, approved: false });
    },
  });

  session.on('attached', (manifest) => {
    logger.beginSession(manifest.sessionId, manifest); // manifest 全量入档（开卷）
    currentSessionId = manifest.sessionId;
    endedScratchRoot = dirname(manifest.scratchDir); // I2：终局惰性清扫的根
    since = Date.now();
    // 能力清单上行（platform 侧存档归真 + 驾驶员可见快照）：attach 即报——
    // 哑管道不缓存，断链窗口期的丢失归平台侧重连/对账面（与 op 族上行同口径）。
    client.send({
      type: 'session.manifest',
      sessionId: manifest.sessionId,
      manifest,
    });
  });

  session.on('ended', (event: MechaSessionEndEvent) => {
    currentSessionId = null;
    driverAgentId = null;
    activeOp = null;
    pendingConfirms.clear(); // 迟到批复不解锁已终局的确认
    since = Date.now();
    logger.endSession(event.reason); // session_end 恒末行 + 关 fd（幂等）
    // I2 惰性孤儿清扫：自身 scratch 已随终局焚毁，此处清同根下上次崩溃
    // 运行的残留（mtime 早于本 daemon 开机）——卫生性动作，失败已内吞。
    sweepOrphanScratch(endedScratchRoot, startedAtMs);
    endedScratchRoot = null;
  });

  // ── 设备通道（出站单向 ws，client 只连不监听）────────────────────────────
  const relayUrl = opts.relayUrl ?? deriveRelayUrl(config.apiBase);
  // 最终地址协议门（T16 fix Minor）：relayUrl 覆盖与 apiBase 换算共用同一
  // 闸——非 ws(s) 地址会让首拨同步抛错、重连链死亡（一次 warn 后静默空转）。
  if (!/^wss?:\/\//i.test(relayUrl)) {
    throw new Error(
      `机甲设备通道地址须为 ws(s):// 地址（收到 ${JSON.stringify(relayUrl)}）`,
    );
  }
  const client = new DeviceClient({
    url: relayUrl,
    deviceId: config.deviceId,
    mechaVersion: MECHA_PACKAGE_VERSION,
    token: config.deviceToken, // 设备鉴权（T17）：随 device.hello 上行
    wire: {
      offer: (frame: MechaSessionOfferFrame) => {
        const decision = session.offer(frame); // accept 路径同步 emit 'attached'
        if (decision.decision === 'accept') {
          driverAgentId = frame.driverAgentId;
          client.send({ type: 'session.accept', sessionId: frame.sessionId });
        } else {
          client.send({ type: 'session.reject', reason: decision.reason });
        }
      },
      pause: () => {
        const sessionId = currentSessionId;
        if (sessionId === null) {
          client.send({ type: 'session.reject', reason: 'no active session' });
          return;
        }
        session.pause();
        logLifecycle('paused');
        client.send({ type: 'session.accept', sessionId });
      },
      resume: () => {
        const sessionId = currentSessionId;
        if (sessionId === null) {
          client.send({ type: 'session.reject', reason: 'no active session' });
          return;
        }
        session.resume();
        logLifecycle('resumed');
        client.send({ type: 'session.accept', sessionId });
      },
      end: (frame) => {
        const sessionId = currentSessionId;
        if (sessionId === null) {
          client.send({ type: 'session.reject', reason: 'no active session' });
          return;
        }
        session.disarm(frame.reason); // 'ended' 事件同步收尾（焚 scratch + 合卷）
        client.send({ type: 'session.accept', sessionId }); // 终局受理回执
      },
      policyUpdate: (frame: MechaPolicyUpdateFrame) => {
        const outcome = session.policyUpdate(frame); // 记账经 deps.onPolicyUpdate
        if (outcome.applied) {
          client.send({
            type: 'session.accept',
            sessionId: currentSessionId ?? '',
          });
        } else {
          client.send({
            type: 'session.reject',
            reason: outcome.error ?? 'policy update rejected',
          });
        }
      },
      op: (envelope) => {
        activeOp = envelope.opId; // 执行中（含等确认）对 IPC status 可见
        void session.executeOp(envelope).then((result) => {
          client.send(result); // mecha.opResult 上行
          if (activeOp === envelope.opId) activeOp = null;
        });
      },
      confirmResult: (msg) => {
        const entry = pendingConfirms.get(msg.requestId);
        if (entry === undefined) return; // 迟到/未知批复（已被会话收割）——忽略
        pendingConfirms.delete(msg.requestId);
        logger.logConfirm(entry.req, msg); // 司机批复成对入档（人批/人拒）
        entry.resolve(msg);
      },
    },
    onLinkChange: (up) => {
      if (up) {
        logLifecycle(session.markLinkUp()); // 'resumed' | 'grace_expired'
      } else {
        session.markLinkDown(); // 失电（宁杀勿失控）：杀 exec + 收割确认 + 宽限计时
        pendingConfirms.clear();
        logLifecycle('link_down');
      }
    },
  });

  // ── 本地 IPC（离线刹车通道；T15 纪律：handler 同步返回）──────────────────
  // 端点名带 home（T16 ledger (a)-minor）：homeOverride 时 POSIX UDS 与
  // logs/provenance 同宇宙——CLI 侧以同一 override 推导端点即可找到 daemon；
  // win32 命名管道与文件系统无关（ipcName 内部忽略）。
  const ipc = new IpcServer(safeIpcName(config.profile, home), {
    status: () => ({
      state: session.state,
      ...(currentSessionId !== null
        ? {
            sessionId: currentSessionId,
            ...(driverAgentId !== null ? { driverAgentId } : {}),
          }
        : {}),
      since,
      ...(activeOp !== null ? { activeOp } : {}),
    }),
    halt: () => {
      const sessionId = currentSessionId;
      if (sessionId === null) return; // 幂等：无会话即无事可刹
      // 落账须在合卷前（'ended' 事件随即 endSession，session_end 恒末行）
      logLifecycle('consumer_halt');
      session.disarm('consumer_halt'); // 杀 exec + 收割确认 + 焚 scratch（幂等）
    },
  });

  // ── 开机：先拨设备通道（握手与 IPC 监听并行推进），IPC 就绪即返回 ─────────
  void client.connect().catch((err: unknown) => {
    // 首连失败不阻断开机（「服务未起」是守护进程开机的常态而非终局——
    // 后台重连循环接管）；拒绝仅作诊断面输出。
    console.warn(`[mecha] 初始连接失败（将自动重试）: ${errMsg(err)}`);
  });
  await ipc.listen();

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (currentSessionId !== null) {
      session.disarm('platform'); // 在会终局：焚 scratch + 合卷（'ended' 事件）
    }
    pendingConfirms.clear();
    client.close(); // 停重连/心跳、关 socket；挂等的 connect() 以拒绝收场
    await ipc.close();
    // logger 无独立 flush 面：每行 writeFileSync 直落（T13 crash-safe 设计），
    // endSession 已关全部会话 fd——停机后无资源可泄。
  };

  return { stop };
}
