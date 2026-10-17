import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { MECHA_PACKAGE_VERSION } from './constants.js';
import {
  MechaExecutor,
  type MechaConfirmMeta,
  type MechaConfirmSettlement,
  type ExecutorLogger,
} from './ops/executor.js';
import type { ProvenanceStore } from './enforcement/provenance.js';

/**
 * 机甲会话状态机（plan Task 12）：单 token（独占）、失电保护（断链即杀 +
 * 宽限重连 + 超时自动终局）、即焚（scratch 递归删除，provenance 永不清）。
 *
 * 状态：`idle`（无会话，可接新 offer）→ `armed`（驾驶中）⇄ `paused`
 * （驾驶员离席，op 全拒但链路/心跳照常）。断链不进独立状态——`armed`/`paused`
 * 之上的 `linkDown` 闸位 + 60s 宽限计时器表达（markLinkUp 返回值即裁决）。
 *
 * 绑定规则（spec §4.2 A7/A9/A11、§6.1-6 + ledger 裁定）：
 *
 *  1. offer（idle→armed）：schema 校验 → accept → scratch 建立
 *     `<首白名单目录>/.clawrent/scratch/<sessionId>/` → 以 offered policy
 *     构造本会话专属 MechaExecutor（「token 携带策略 = 会话即策略」——executor
 *     每会话一个，终局即弃）→ state 'armed' → emit 'attached'（CapabilityManifest）。
 *     sessionId 硬校验（禁分隔符/点段）：即焚 rmSync 的目标由 sessionId 参与
 *     构成，路径逃逸 = 焚他人目录，此门不可无。
 *  2. 独占（A7）：非 idle 时第二 offer → reject reason 'busy'，状态不变。
 *  3. pause()/resume()：armed↔paused；paused 时 op 一律 IO_ERROR 'paused'
 *     拒回（无确认弹窗），链路/心跳照常，独占仍然成立。
 *  4. markLinkDown（失电，宁杀勿失控）：立即 `executor.killActiveExec()` +
 *     取消全部等待中的确认（T11 约束 #1——等批的 op 人批后仍会起进程，迟到
 *     批准绝不能放行）+ 停收新 op（IO_ERROR 'link down' 立拒，不排队）+
 *     起宽限计时器（policy.limits.disconnectGraceMs，默认 60s）。
 *  5. markLinkUp：宽限内 → 清计时器、撤闸，返回 'resumed'（回到断链前
 *     armed/paused 态）；宽限外/未断链 → 'grace_expired'。宽限到点无人认领 →
 *     自动终局（teardown('grace_expired')）——「超时自动 end」，会话绝不无限
 *     期悬挂占锁。
 *  6. disarm(reason) / session.end 帧（任何 reason）→ killActiveExec + 取消
 *     pending 确认 + 即焚（scratchDir 递归删除；**非 scratch 交付物不在此路径，
 *     不焚**；**provenance 永不清**——跨会话判红的红链是安全资产）+ executor
 *     弃用 + policy 失活（token 作废）+ state idle + emit 'ended'{reason}。
 *     幂等：终局只发生一次。
 *  7. policy.update：tighten（信任 direction 字段）→ 立即替换 active policy
 *     （executor 每 op 现取 policy，下一 op 即生效）；expand 无 authorizationRef
 *     → 硬拒（状态不变）；expand 带 authorizationRef → 替换。每次处置（含拒）
 *     均回调 deps.onPolicyUpdate(frame, applied)——T13/T16 接行车记录。
 *  8. 确认包装（T1/T2 300s 默认拒）：session 包装原始 confirm 回调——
 *     Promise.race 计时（policy.limits.confirmTimeoutMs，默认 300s），结算即
 *     清计时器；超时/断链取消以 `approved:false + confirmEnd 标记` 结算
 *     （MechaConfirmSettlement），executor 据标记产出 CONFIRM_TIMEOUT /
 *     IO_ERROR 'link down' 结果。原始回调的拒绝（人拒）原样透传。
 *     T1-remember（I3 fix，spec §5.3）：exec.run + T1 的批复携带
 *     `remember:true` → 程序真身入会话记忆集，本会话内同程序 exec 免确认
 *     （不发 confirmRequest，留 confirmed_remembered 行）；T2 永不入集，
 *     集随终局清空。
 *  9. op 串行（R15 裁定）：executeOp 以 in-flight promise 链一次只放一个 op
 *     进执行器——审计线性（logOp 顺序 = 执行顺序），T10 read-race 残面收口。
 *     守卫（idle / linkDown / paused）在入队前后各查一次：入队前拒不占队位，
 *     出队时复查保证终局/断链后排队的 op 绝不落到已弃执行器上。
 * 10. 信封绑定（I1 fix）：op 信封的 sessionId 必须与在会 sessionId 一致
 *     （accept 置位、teardown 复位）——错会话信封在入口即 IO_ERROR
 *     'session mismatch' 拒回（不进执行流、不占队位），拒收行落当前会话
 *     日志（logLifecycle 'op_rejected_session_mismatch'；信封 sessionId 无
 *     合法审计落点，op_request 锚不可落）。
 *
 * 会话策略的生命周期归 session 所有：构造 deps 只含 executor 的工厂依赖
 * （provenance/confirm/log/onChunk，policy 与 scratchDir 由 session 按注入的
 * offered policy 逐会话装配）——同机多会话互不串策略、互不串暂存区。
 */

/** 会话状态。 */
export type MechaSessionState = 'idle' | 'armed' | 'paused';

/** session.offer 帧精确类型（T3 裁定：superRefine 包掉 .options，自行 Extract）。 */
export type MechaSessionOfferFrame = Extract<
  Mecha.MechaDeviceFrame,
  { type: 'session.offer' }
>;

/** policy.update 帧精确类型（同上）。 */
export type MechaPolicyUpdateFrame = Extract<
  Mecha.MechaDeviceFrame,
  { type: 'policy.update' }
>;

/** session.pause / session.resume / session.end 帧精确类型（同上；T14/T16 接线消费）。 */
export type MechaSessionPauseFrame = Extract<
  Mecha.MechaDeviceFrame,
  { type: 'session.pause' }
>;
export type MechaSessionResumeFrame = Extract<
  Mecha.MechaDeviceFrame,
  { type: 'session.resume' }
>;
export type MechaSessionEndFrame = Extract<
  Mecha.MechaDeviceFrame,
  { type: 'session.end' }
>;

/** offer 裁决：accept / reject（reason 为人话，v0 不钉枚举——frames.ts 同口径）。 */
export type OfferDecision =
  | { decision: 'accept' }
  | { decision: 'reject'; reason: string };

/** policy.update 处置结果。 */
export interface PolicyUpdateOutcome {
  applied: boolean;
  error?: string;
}

/** 'ended' 事件载荷：reason 六值 verbatim；burnError 仅即焚失败时携带
 * （scratch 删除失败是残留不是失控——终局照常完成，残余响亮暴露）。 */
export interface MechaSessionEndEvent {
  reason: Mecha.MechaSessionEndReason;
  burnError?: string;
}

/** 确认结算的终局口径（onConfirmSettled 通知载荷）：approved/denied = 司机
 * 批复在时效内落地；timeout = 人工批准超时默认拒（会话收割）；link_down =
 * 断链失电收割；ended = 会话终局收割。executor 面的结算对象口径不变
 * （取消类恒 confirmEnd:'link_down'），本细分只走通知面供审计归真。 */
export type MechaConfirmSettlementOutcome =
  | 'approved'
  | 'denied'
  | 'timeout'
  | 'link_down'
  | 'ended';

/** 事件表（监听器故障吞掉——行车记录/计费侧的坏回调绝不炸状态机）。 */
export interface MechaSessionEvents {
  attached: Mecha.CapabilityManifest;
  ended: MechaSessionEndEvent;
}

/** session 构造依赖：executor 的工厂依赖（policy/scratchDir 由 session 逐
 * 会话装配，见文件头）。confirm 为原始接线（T16 接中继/平台转发），session
 * 自行包装超时与断链取消；第二参数 meta（I3 fix）为 executor 在确认发起处
 * 附带的判级产物（op 类型 + tier + exec 程序真身），供 T1-remember 快速
 * 放行——不出现在 MechaConfirmRequest 线形上。onPolicyUpdate 结构回调
 * （ExecutorLogger 同风格）。 */
export interface MechaSessionDeps {
  /** 溯源持久表（单写者，R6 裁定——daemon 级单实例）。即焚不清此表。 */
  provenance: ProvenanceStore;
  /** 原始确认回调：人审通道。session 包装后注入 executor。 */
  confirm: (
    req: Mecha.MechaConfirmRequest,
    meta?: MechaConfirmMeta,
  ) => Promise<Mecha.MechaConfirmResult>;
  /** 行车记录（R8 最小接口；T13 DashcamLogger 结构满足）。 */
  log: ExecutorLogger;
  /** 会话级生命周期落账（I1/I3 fix，可选）：op_rejected_session_mismatch
   * （错会话信封的拒收留痕——锚行按信封 sessionId 寻文件，陌生会话无合法
   * 落点）与 confirmed_remembered（T1-remember 免确认的标记行）经此入当前
   * 会话日志。缺省 = 无处可落时静默跳过（结果不受影响）。 */
  logLifecycle?: (event: string, detail?: unknown) => void;
  /** exec.run 流式回传 sink（透传 executor；缺省丢弃）。 */
  onChunk?: (chunk: Mecha.MechaExecChunk) => void;
  /** policy.update 处置回调（applied 含被拒的更新——T13/T16 接线记账）。 */
  onPolicyUpdate?: (frame: MechaPolicyUpdateFrame, applied: boolean) => void;
  /** 确认结算通知（T16 fix 裁定）：每一条结算路径（approved/denied/timeout/
   * link_down/ended）在 wrappedConfirm 的 finish() 处恰通知一次——下游桥接
   * （T16 daemon）据此摘除等待表项，并为「会话先收割、司机批复后到」的
   * 情形补记真实结算对（批复未到 = 无结算可自记，通知即结算真相的唯一
   * 来源）。原始 confirm 回调自身抛错（通道故障）不通知——发起方即结算
   * 属主，无外溢面。 */
  onConfirmSettled?: (
    requestId: string,
    outcome: MechaConfirmSettlementOutcome,
  ) => void;
}

/** 等待中的确认（cancelPendingConfirms 的收割句柄）。settle 携带通知口径
 * （cancelPendingConfirms 的调用方区分断链失电/会话终局）。 */
interface PendingConfirm {
  requestId: string;
  timer: NodeJS.Timeout;
  settle: (
    result: MechaConfirmSettlement,
    outcome: MechaConfirmSettlementOutcome,
  ) => void;
}

/** 会话空闲兜底策略（fail-closed：空白名单 = fs 全拒；executor 每会话在位
 * 期间 activePolicy 恒非空，此兜底仅为类型完备与终局竞态兜底）。 */
function emptyPolicy(): Mecha.MechaPolicy {
  return {
    dirs: [],
    programs: [],
    limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
  };
}

/** sessionId 硬校验：纯路径段（即焚 rmSync 目标的构成件，逃逸零容忍）；
 * 冒号一并拒——NTFS ADS 流名（`sess:ads` 参与构造的日志名/即焚路径在
 * win32 上可写进交替数据流，I1 final review 同规则收口）。 */
function isValidSessionId(id: string): boolean {
  if (id === '' || id === '.' || id === '..') return false;
  if (id.includes('/') || id.includes('\\') || id.includes(':')) return false;
  return true;
}

/**
 * policy.update 帧的形状级校验（不经 MechaDeviceFrameSchema 联合 parse）：
 * 联合级 superRefine 会把「expand 无 authorizationRef」整帧判废——而 session
 * 恰恰要把这一情形从「帧本身无效」里分出来：自陈硬拒（'expand requires
 * authorizationRef'）并经 onPolicyUpdate 记账（applied:false，全量记账裁定）。
 * 形状单一事实源不破：type/direction 按协议字面与枚举常量核、authorizationRef
 * 按帧 schema 口径（string | undefined）、policy 形状仍交 MechaPolicySchema。
 */
function parsePolicyUpdateShape(raw: unknown): MechaPolicyUpdateFrame | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['type'] !== 'policy.update') return null;
  const direction = r['direction'];
  if (
    direction !== 'expand' &&
    direction !== 'tighten'
  ) {
    return null;
  }
  const authRef = r['authorizationRef'];
  if (authRef !== undefined && (typeof authRef !== 'string' || authRef === '')) {
    return null; // 帧 schema min(1) 同口径
  }
  const policy = Mecha.MechaPolicySchema.safeParse(r['policy']);
  if (!policy.success) return null;
  return {
    type: 'policy.update',
    policy: policy.data,
    direction,
    authorizationRef: authRef as string | undefined,
  };
}

/** 会话级 op 拒绝结果（IO_ERROR 一码到底：paused/link down/无会话/终局）。 */
function sessionFail(opId: string, message: string): Mecha.MechaOpResult {
  return { opId, ok: false, error: { code: Mecha.MECHA_ERROR_CODES[6], message } };
}

export class MechaSession {
  private readonly deps: MechaSessionDeps;

  private stateValue: MechaSessionState = 'idle';

  /** 会话态（accept 置位、teardown 复位；idle 时均为 null）。 */
  private activePolicy: Mecha.MechaPolicy | null = null;
  private scratchDirValue: string | null = null;
  private executor: MechaExecutor | null = null;

  /** 在会 sessionId（I1 fix）：op 信封绑定的比对基线——accept 置位、
   * teardown 复位。错会话信封的 op 在 executeOp 入口即拒，绝不落到本会话
   * 的策略/执行器/审计流上。 */
  private activeSessionId: string | null = null;

  /** T1-remember 记忆集（I3 fix，spec §5.3）：本会话内消费者勾选「不再
   * 确认」的 exec 程序真身（matchProgram 产物 absPath）。仅 T1 exec 命中；
   * T2（上传脚本/内联/溯源红）永不入集。集随终局清空——新 offer = 新集。 */
  private readonly rememberedPrograms = new Set<string>();

  /** 断链闸位（armed/paused 之上；宽限计时器在跑即为 true）。 */
  private linkDown = false;
  private graceTimer: NodeJS.Timeout | null = null;

  /** 等待中的人工确认（包装回调登记；断链/终局统一收割）。 */
  private readonly pendingConfirms = new Map<string, PendingConfirm>();

  /** op 串行链（R15）：一次只放一个 op 进执行器。 */
  private opChain: Promise<unknown> = Promise.resolve();

  private readonly listeners: {
    [K in keyof MechaSessionEvents]: Set<(payload: MechaSessionEvents[K]) => void>;
  } = { attached: new Set(), ended: new Set() };

  constructor(deps: MechaSessionDeps) {
    this.deps = deps;
  }

  /** 当前会话状态（只读——状态迁移只经状态机方法）。 */
  get state(): MechaSessionState {
    return this.stateValue;
  }

  /** 订阅会话事件（'attached' / 'ended'）。监听器异常被吞（尽力而为）。 */
  on<K extends keyof MechaSessionEvents>(
    event: K,
    cb: (payload: MechaSessionEvents[K]) => void,
  ): void {
    this.listeners[event].add(cb);
  }

  private emit<K extends keyof MechaSessionEvents>(
    event: K,
    payload: MechaSessionEvents[K],
  ): void {
    for (const cb of this.listeners[event]) {
      try {
        cb(payload);
      } catch {
        // 监听器故障不炸状态机（行车记录/计费侧健壮性归各自 Task）
      }
    }
  }

  // ── offer（idle → armed，独占 A7）─────────────────────────────────────────

  /**
   * 处置 session.offer：idle 时校验帧并决策；非 idle 一律 reject 'busy'
   * （独占 A7——先查独占再做无用功）。校验失败/无 scratch 落点 → reject，
   * 状态不变；accept 路径上的任何失败都发生在状态迁移之前（fail-closed）。
   */
  offer(raw: unknown): OfferDecision {
    if (this.stateValue !== 'idle') {
      return { decision: 'reject', reason: 'busy' };
    }
    const parsed = Mecha.MechaDeviceFrameSchema.safeParse(raw);
    if (!parsed.success || parsed.data.type !== 'session.offer') {
      return { decision: 'reject', reason: 'invalid offer' };
    }
    return this.acceptOffer(parsed.data);
  }

  private acceptOffer(frame: MechaSessionOfferFrame): OfferDecision {
    // sessionId 硬校验（即焚路径构成件，逃逸零容忍——见文件头规则 1）
    if (!isValidSessionId(frame.sessionId)) {
      return { decision: 'reject', reason: 'invalid offer' };
    }
    // scratch 落点 = 首白名单目录下（spec §5.6 即焚区）；无目录 = 无落点，
    // fail-closed 拒（策略 schema 允许空 dirs，但空 dirs 的会话无法 attach）。
    const base = frame.policy.dirs[0];
    if (base === undefined) {
      return { decision: 'reject', reason: 'invalid offer: policy has no directories' };
    }
    const scratchDir = path.join(base, '.clawrent', 'scratch', frame.sessionId);
    try {
      fs.mkdirSync(scratchDir, { recursive: true });
    } catch (err) {
      return {
        decision: 'reject',
        reason: `scratch init failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // 会话即策略：以 offered policy 构造本会话专属执行器（终局即弃）。
    // policy 取值器每 op 现取——policy.update tighten 立即生效的前提。
    this.activePolicy = frame.policy;
    this.activeSessionId = frame.sessionId;
    this.executor = new MechaExecutor({
      policy: () => this.activePolicy ?? emptyPolicy(),
      provenance: this.deps.provenance,
      confirm: (req, meta) => this.wrappedConfirm(req, meta),
      log: this.deps.log,
      scratchDir,
      onChunk: this.deps.onChunk,
    });

    this.scratchDirValue = scratchDir;
    this.stateValue = 'armed';

    // attach 回执：本会话能力快照（mechaVersion 单一事实源 = 包常量）。
    this.emit('attached', {
      sessionId: frame.sessionId,
      policy: frame.policy,
      mechaVersion: MECHA_PACKAGE_VERSION,
      scratchDir,
    });
    return { decision: 'accept' };
  }

  // ── pause / resume ────────────────────────────────────────────────────────

  /** armed/paused → paused（幂等；idle 抛错——本地 API 契约响亮，wire 侧走
   * handleFrame 的 reject 口径）。paused：op 全拒、链路心跳照常、独占仍成立。 */
  pause(): void {
    if (this.stateValue === 'idle') {
      throw new Error('MechaSession.pause: no active session');
    }
    this.stateValue = 'paused';
  }

  /** paused/armed → armed（幂等；idle 抛错同上）。 */
  resume(): void {
    if (this.stateValue === 'idle') {
      throw new Error('MechaSession.resume: no active session');
    }
    this.stateValue = 'armed';
  }

  // ── 断链失电（宁杀勿失控）─────────────────────────────────────────────────

  /**
   * 链路断开（设备 ↔ 平台 WS 掉线）：立即失电——杀运行中 exec 进程树、
   * 取消等待中的确认（迟到批准绝不放行）、停收新 op（立拒不排队），并起
   * 宽限计时器（policy.limits.disconnectGraceMs，默认 60s）。幂等；idle 时
   * 无会话可失电（no-op）。
   */
  markLinkDown(): void {
    if (this.stateValue === 'idle' || this.linkDown) return;
    this.linkDown = true;
    this.executor?.killActiveExec();
    this.cancelPendingConfirms('link_down');
    const graceMs =
      this.activePolicy?.limits.disconnectGraceMs ??
      Mecha.MECHA_LIMITS_DEFAULTS.disconnectGraceMs;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      // 宽限到点无人认领：自动终局（「超时自动 end」，会话绝不悬挂占锁）
      this.teardown('grace_expired');
    }, graceMs);
  }

  /**
   * 链路恢复：宽限内 → 清计时器撤闸，返回 'resumed'（回到断链前 armed/paused
   * 态，op 恢复收）；宽限外或本就未断链 → 'grace_expired'（宽限到点时 teardown
   * 已自动终局——此返回值即「你来晚了」的裁决，供上层发 error 帧/审计）。
   */
  markLinkUp(): 'resumed' | 'grace_expired' {
    if (!this.linkDown) return 'grace_expired';
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.linkDown = false;
    return this.stateValue === 'idle' ? 'grace_expired' : 'resumed';
  }

  // ── 终局（disarm / session.end）───────────────────────────────────────────

  /** 终局（任何 reason，幂等）：失电 → 取消确认 → 即焚 → 全量复位 →
   * 'ended' 事件。见文件头规则 6。 */
  disarm(reason: Mecha.MechaSessionEndReason): void {
    this.teardown(reason);
  }

  private teardown(reason: Mecha.MechaSessionEndReason): void {
    if (this.stateValue === 'idle') return; // 终局只发生一次
    // 失电优先：杀运行中 exec（幂等，宁杀勿失控）
    this.executor?.killActiveExec();
    this.cancelPendingConfirms('ended');
    if (this.graceTimer !== null) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    this.linkDown = false;
    // 即焚：scratch 递归删除。非 scratch 交付物不在此路径（不焚）；
    // provenance 永不清（跨会话判红）。删除失败 = 残留不是失控：终局照常
    // 完成，残余经 burnError 响亮暴露（不静默）。
    let burnError: string | undefined;
    try {
      if (this.scratchDirValue !== null) {
        fs.rmSync(this.scratchDirValue, { recursive: true, force: true });
      }
    } catch (err) {
      burnError = err instanceof Error ? err.message : String(err);
    }
    // token 作废：executor 弃用、policy 失活、信封绑定与 T1-remember 集清空
    //（之后新 offer 可建全新会话——同机服务循环不受本次终局影响）。
    this.executor = null;
    this.activePolicy = null;
    this.activeSessionId = null;
    this.rememberedPrograms.clear();
    this.scratchDirValue = null;
    this.stateValue = 'idle';
    this.emit('ended', burnError === undefined ? { reason } : { reason, burnError });
  }

  // ── policy.update ─────────────────────────────────────────────────────────

  /**
   * 处置 policy.update 帧：tighten（信任 direction 字段，不做本地收紧比对）
   * 或带 authorizationRef 的 expand → 立即替换 active policy（executor 每 op
   * 现取，下一 op 即生效）；expand 无 authorizationRef → 硬拒（状态不变）；
   * idle 无会话 → 拒（无可更新的在会话策略）。每次处置（含拒）均回调
   * deps.onPolicyUpdate(frame, applied)——全量记账（T13/T16 接行车记录）。
   * 帧解析走形状级 gate（见 parsePolicyUpdateShape——superRefine 废帧无法
   * 记账的张力在此化解）。
   */
  policyUpdate(raw: unknown): PolicyUpdateOutcome {
    const frame = parsePolicyUpdateShape(raw);
    if (frame === null) {
      return { applied: false, error: 'invalid policy.update frame' };
    }
    let outcome: PolicyUpdateOutcome;
    if (this.stateValue === 'idle') {
      outcome = { applied: false, error: 'no active session' };
    } else if (frame.direction === 'expand' && frame.authorizationRef === undefined) {
      // 放宽执行边界必须可追溯到授权记录——缺授权硬拒（spec §6 裁定；
      // wire 层 superRefine 之外的第二道防线：直接 API 调用也过不了）。
      outcome = {
        applied: false,
        error: 'expand requires authorizationRef',
      };
    } else {
      this.activePolicy = frame.policy; // executor 每 op 现取 → 立即生效
      outcome = { applied: true };
    }
    this.deps.onPolicyUpdate?.(frame, outcome.applied);
    return outcome;
  }

  // ── 设备帧路由（T14/T16 单一入口）────────────────────────────────────────

  /**
   * 设备通道帧统一入口：解析（schema + superRefine）→ 按 type 分派。session
   * 相关帧返回处置裁决（offer 决策、pause/resume/end 受理、policy.update
   * 处置），不归 session 管的帧（device.hello / heartbeat / welcome /
   * heartbeat_ack / error）返回 undefined（交由 client 层自处）。
   * 坏帧 → reject 'invalid frame'。
   */
  handleFrame(raw: unknown): OfferDecision | undefined {
    const parsed = Mecha.MechaDeviceFrameSchema.safeParse(raw);
    if (!parsed.success) return { decision: 'reject', reason: 'invalid frame' };
    const frame = parsed.data;
    switch (frame.type) {
      case 'session.offer':
        return this.offer(raw);
      case 'session.pause':
        if (this.stateValue === 'idle') {
          return { decision: 'reject', reason: 'no active session' };
        }
        this.pause();
        return { decision: 'accept' };
      case 'session.resume':
        if (this.stateValue === 'idle') {
          return { decision: 'reject', reason: 'no active session' };
        }
        this.resume();
        return { decision: 'accept' };
      case 'session.end':
        if (this.stateValue === 'idle') {
          return { decision: 'reject', reason: 'no active session' };
        }
        this.disarm(frame.reason);
        return { decision: 'accept' };
      case 'policy.update': {
        const out = this.policyUpdate(raw);
        return out.applied
          ? { decision: 'accept' }
          : { decision: 'reject', reason: out.error ?? 'policy update rejected' };
      }
      default:
        return undefined; // hello/welcome/heartbeat(_ack)/error 不归 session 管
    }
  }

  // ── op 执行（守卫 + 串行 R15）────────────────────────────────────────────

  /**
   * 驾驶 op 入口：守卫（无会话 / 断链 / 暂停 → IO_ERROR 立拒，不排队）→
   * 串行链尾挂执行（R15 一次一个，审计线性）。出队时复查守卫——终局/断链
   * 发生在排队期间时，该 op 绝不落到已弃执行器上（IO_ERROR 'session ended'
   * / 'link down' 拒回）。executor 契约「每 op 必有结果」，此处无异常路径。
   */
  async executeOp(envelope: Mecha.MechaOpEnvelope): Promise<Mecha.MechaOpResult> {
    // 信封绑定门（I1 fix，先于守卫与队列——错会话的 op 不进本会话的执行
    // 流、不占队位）。锚行（op_request）归 executor 按信封 sessionId 寻
    // 文件，陌生会话无合法落点（fail-loud 会抛）——此处不落锚，改在**当前
    // 会话**日志留一条 lifecycle 拒收行，随后以 IO_ERROR 'session mismatch'
    // 拒回（零执行、零确认、零副作用）。
    if (
      this.activeSessionId !== null &&
      envelope.sessionId !== this.activeSessionId
    ) {
      try {
        this.deps.logLifecycle?.('op_rejected_session_mismatch', {
          opId: envelope.opId,
          claimedSessionId: envelope.sessionId,
        });
      } catch {
        // 审计尽力而为：日志故障不改变拒收结果
      }
      return sessionFail(envelope.opId, 'session mismatch');
    }
    const immediate = this.opGate(envelope.opId);
    if (immediate !== null) return immediate;

    const turn = this.opChain.then(async () => {
      // 出队复查（入队后终局/断链/暂停可能已发生）：绝不把排队 op 落到
      // 已弃执行器上。idle 用 'session ended'（曾受理、终局时被清退）——
      // 与入队时的 'no active session'（调用方打着无会话）区分诊断面。
      if (this.stateValue === 'idle') return sessionFail(envelope.opId, 'session ended');
      if (this.linkDown) return sessionFail(envelope.opId, 'link down');
      if (this.stateValue === 'paused') return sessionFail(envelope.opId, 'paused');
      return this.executor!.execute(envelope);
    });
    this.opChain = turn.then(
      () => undefined,
      () => undefined, // executor 不抛（兜底 IO_ERROR）；链永不断裂
    );
    return turn;
  }

  /** op 守卫（入队前）：null = 放行；否则为拒绝结果。出队复查在 executeOp
   * 内联（idle 细分 'session ended'——曾受理、终局被清退的诊断面）。 */
  private opGate(opId: string): Mecha.MechaOpResult | null {
    if (this.stateValue === 'idle') return sessionFail(opId, 'no active session');
    if (this.linkDown) return sessionFail(opId, 'link down');
    if (this.stateValue === 'paused') return sessionFail(opId, 'paused');
    return null;
  }

  // ── 确认包装（T1/T2 300s 默认拒 + 断链取消，T11 约束 #1）────────────────

  /**
   * 包装原始 confirm 回调（executor.deps.confirm 实体）：
   *  - T1-remember 快速放行（I3 fix，spec §5.3「本会话不再确认」的兑现）：
   *    meta 表明本次确认是 exec.run + T1 且程序真身在记忆集 → 不发
   *    mecha.confirmRequest、无 300s 窗口，直接 approved 结算，并在当前
   *    会话日志留 confirmed_remembered 生命周期行。T2 永不命中——meta.tier
   *    由 executor 判级产物携带，computeTier 照常先跑、其 T2 判定先于本
   *    检查（requireConfirm 只在判级后调用）；
   *  - 断链/无会话态：不经通道，直接以 `approved:false + link_down` 结算；
   *  - 在途：Promise.race 原始回调与 policy.limits.confirmTimeoutMs 计时
   *    （默认 300s）——结算即清计时器；超时以 `approved:false + timeout`
   *    结算（executor 据标记产出 CONFIRM_TIMEOUT）；
   *  - 原始回调先答：原样透传（approved / 人拒 CONFIRM_DENIED 原口径）；
   *    approved+remember 且本次是 exec.run T1 → 程序真身入记忆集（终局清）；
   *  - 原始回调抛错（通道故障）：透传给 executor（execute 兜底 IO_ERROR，
   *    与 Task 10/11 既有口径一致——通道故障 ≠ 人拒）；
   *  - 断链/终局收割：所有 pending 以 `approved:false + link_down` 结算——
   *    迟到的批准拿到的是已结算的 race，绝不放行（文件头规则 4/6）。
   */
  private wrappedConfirm(
    req: Mecha.MechaConfirmRequest,
    meta?: MechaConfirmMeta,
  ): Promise<MechaConfirmSettlement> {
    if (
      this.linkDown === false &&
      this.executor !== null &&
      meta !== undefined &&
      meta.tier === 'T1' &&
      meta.opType === 'exec.run' &&
      meta.programAbsPath !== undefined &&
      this.rememberedPrograms.has(meta.programAbsPath)
    ) {
      try {
        this.deps.logLifecycle?.('confirmed_remembered', {
          opId: req.opId,
          program: meta.programAbsPath,
        });
      } catch {
        // 审计尽力而为：免确认放行不因日志故障改道
      }
      // 结算通知（口径不变：每条会话裁定的结算路径恰通知一次——daemon 桥
      // 无此表项，通知扑空即静默）
      this.deps.onConfirmSettled?.(req.requestId, 'approved');
      return Promise.resolve({ requestId: req.requestId, approved: true });
    }
    if (this.linkDown || this.executor === null) {
      return Promise.resolve({
        requestId: req.requestId,
        approved: false,
        confirmEnd: 'link_down',
      });
    }
    const timeoutMs =
      this.activePolicy?.limits.confirmTimeoutMs ??
      Mecha.MECHA_LIMITS_DEFAULTS.confirmTimeoutMs;
    return new Promise<MechaConfirmSettlement>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      let settled = false;
      const finish = (
        outcome: MechaConfirmSettlementOutcome | null,
        settle: () => void,
      ): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer); // 结算即清（无悬挂计时器）
        this.pendingConfirms.delete(req.requestId);
        // 结算通知（T16 fix）：每条会话裁定的结算路径恰通知一次——outcome
        // 为 null = 原始回调自身抛错（通道故障，发起方即结算属主，不通知）。
        if (outcome !== null) this.deps.onConfirmSettled?.(req.requestId, outcome);
        settle();
      };
      timer = setTimeout(() => {
        finish('timeout', () =>
          resolve({ requestId: req.requestId, approved: false, confirmEnd: 'timeout' }),
        );
      }, timeoutMs);
      this.pendingConfirms.set(req.requestId, {
        requestId: req.requestId,
        timer,
        settle: (result, outcome) => finish(outcome, () => resolve(result)),
      });
      this.deps.confirm(req).then(
        (r) => {
          // I3：approved + remember 且本次是 exec.run T1 → 程序真身入记忆集
          //（会话内后续同程序 exec 免确认；T2 不入集；终局清空）。NB-4 守卫：
          // executor 非空才入集——终局收割后的迟到批复（direct-library 接线
          // 的原始 promise 兑现）不得为已死的会话留下记忆（新 offer = 新集）。
          if (
            this.executor !== null &&
            r.approved &&
            r.remember === true &&
            meta !== undefined &&
            meta.tier === 'T1' &&
            meta.opType === 'exec.run' &&
            meta.programAbsPath !== undefined
          ) {
            this.rememberedPrograms.add(meta.programAbsPath);
          }
          finish(r.approved ? 'approved' : 'denied', () => resolve({ ...r }));
        },
        (err) =>
          finish(
            null,
            () =>
              reject(err instanceof Error ? err : new Error(String(err))),
          ),
      );
    });
  }

  /** 收割全部等待中的确认：`approved:false + link_down` 结算 + 清计时器 +
   * 结算通知（outcome 细分断链失电/会话终局——executor 面的结算对象恒
   * link_down 口径不变，通知面细分供审计归真，T16 fix）。
   * markLinkDown 与 teardown 共用（断链/终局同一失电口径）。 */
  private cancelPendingConfirms(outcome: 'link_down' | 'ended'): void {
    const pending = [...this.pendingConfirms.values()];
    this.pendingConfirms.clear();
    for (const p of pending) {
      p.settle(
        { requestId: p.requestId, approved: false, confirmEnd: 'link_down' },
        outcome,
      );
    }
  }
}
