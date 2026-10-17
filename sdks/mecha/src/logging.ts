import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mecha } from '@clawrent/protocol';
import type { MechaConfirmSettlement } from './ops/executor.js';
import type { MechaPolicyUpdateFrame } from './session.js';

/**
 * 行车记录仪（spec §6.1-2 安全件 #2，plan Task 13）：本地全量审计日志——
 * 「当时授权了什么、实际做了什么、人批了什么、边界改了什么、会话怎么结束」
 * 五问的落盘证据面。每会话一个 `logsDir/<sessionId>.jsonl`，一行一条 JSON
 * （JSONL），每行含 `timestamp`（ISO string）。
 *
 * 行格式（`kind` 判别）：
 *   - `session_begin`：manifest 全量入档——policy 快照（白名单目录 + 程序表 +
 *     限额）即「当时授权了什么」的原始记录；
 *   - `op_request`：op 进入执行流（判级前）的取证锚点（R19）——op_request
 *     落于执行前、result（`op`）落于完成后；op_request 无对应 result 行 =
 *     该 op 被会话终局收割（killed/halt/end），由 session_end 行解释（任何
 *     被考虑执行的 op 至少留一行）；
 *   - `op`：envelope + result 全量 verbatim——fs.write / file.upload 的
 *     content 字段携带驾驶员内容，正是审计载荷，原文入档（spec §6.1-2
 *     「T2 脚本全文入档」的追责证据；脚本即焚后此处是唯一全文留存）；
 *   - `confirm`：request（含 T1/T2 tier 与 summary）+ result 同行成对——
 *     result 形状为 MechaConfirmSettlement（plain MechaConfirmResult 兼容，
 *     session 包装层注入的 confirmEnd 标记 timeout/link_down 一并入档，
 *     「非人拒」的确认结局可追溯）；
 *   - `policy_update`：frame + applied——被拒的更新（applied:false）同样
 *     入档（session 全量记账裁定，「白名单变更入审计」含未遂）；
 *   - `lifecycle`：自由事件名（attached/paused/resumed/link_down/
 *     grace_expired/ended/...）+ 可选 detail；
 *   - `session_end`：六值 reason，恒为该文件末行。
 *
 * 写入机制（裁定申明）：每会话持有 append 模式 fd（beginSession 惰性 open、
 * endSession 关闭），每行一次 `fs.writeFileSync(fd, line)`——Node 内部保证
 * 写满才返回，O_APPEND 追加语义行缓冲落盘：进程崩溃至多缺最后一行，已落行
 * 绝不撕裂（crash-safe = 一行一 JSON 恒成立）。
 *
 * 审计优先（全局红线）：本类绝不自吞任何异常——fd open/write 失败、JSON
 * 序列化失败一律原样上抛（审计行绝不静默丢弃）。executor 侧对 logOp 的
 * 「尽力而为」吞错是其既有契约（不回改 op 结果），与 logger 自身响亮不冲突；
 * daemon 直连线（confirm/policy/lifecycle）的异常向上可见，接线处响亮暴露。
 *
 * 会话寻址：logOp 按 envelope.sessionId 寻文件（该会话未 beginSession 即抛
 * ——fail-loud）；logConfirm / logPolicyUpdate / logLifecycle 所依协议帧无
 * sessionId 字段，落「当前会话」（beginSession 置位、endSession 清位——
 * MechaSession 单 token 独占 A7，同一时刻至多一个在会话），无在会话即抛。
 *
 * 幂等（daemon 重启边缘）：endSession 对未开始/已结束的会话 no-throw no-op
 * （无事可记、无 fd 可关）；beginSession 同 id 重入不抛——fd 不重开（不泄漏
 * 不串写），session_begin 追加一行（重入本身即是审计事实）。
 *
 * sessionId 硬校验（与 session.ts 同规则）：日志文件名由 sessionId 参与构成，
 * 分隔符/点段 = 写文件路径逃逸，入口即拒（session 已有同规则，此处纵深）。
 */

/** 行车记录单行载荷（kind 判别联合；timestamp 由 write 统一前置）。 */
type DashcamLine =
  | { kind: 'session_begin'; manifest: Mecha.CapabilityManifest }
  | { kind: 'op_request'; envelope: Mecha.MechaOpEnvelope }
  | { kind: 'op'; envelope: Mecha.MechaOpEnvelope; result: Mecha.MechaOpResult }
  | { kind: 'confirm'; request: Mecha.MechaConfirmRequest; result: MechaConfirmSettlement }
  | { kind: 'policy_update'; frame: MechaPolicyUpdateFrame; applied: boolean }
  | { kind: 'lifecycle'; event: string; detail?: unknown }
  | { kind: 'session_end'; reason: Mecha.MechaSessionEndReason };

/** sessionId 硬校验（与 session.ts isValidSessionId 同规则）：日志文件路径
 * 的构成件，分隔符/点段 = 写逃逸，零容忍。 */
function assertSessionId(id: string): void {
  if (id === '' || id === '.' || id === '..' || id.includes('/') || id.includes('\\')) {
    throw new Error(`DashcamLogger: sessionId 必须为纯路径段，收到 ${JSON.stringify(id)}`);
  }
}

export class DashcamLogger {
  /** 在会话 fd 表（sessionId → append fd；endSession 关闭并摘除）。 */
  private readonly fds = new Map<string, number>();

  /** 当前会话（beginSession 置位、endSession 清位；logConfirm/logPolicyUpdate/
   * logLifecycle 的落点——协议帧无 sessionId，单 token 独占下唯一）。 */
  private currentSessionId: string | null = null;

  constructor(private readonly logsDir: string) {
    // 目录自建；失败即抛（审计优先：落点不在即响亮失败，不带病运行）
    fs.mkdirSync(logsDir, { recursive: true });
  }

  /** 会话开卷：惰性 open append fd（已开则复用）+ 置当前会话 + 落
   * session_begin 行（manifest 全量）。 */
  beginSession(sessionId: string, manifest: Mecha.CapabilityManifest): void {
    assertSessionId(sessionId);
    if (!this.fds.has(sessionId)) {
      this.fds.set(sessionId, fs.openSync(this.fileFor(sessionId), 'a'));
    }
    this.currentSessionId = sessionId;
    this.write(sessionId, { kind: 'session_begin', manifest });
  }

  /** op 执行锚点行（R19）：op 进入执行流（判级前）即落一行——「任何被考虑
   * 执行的 op 至少留一行」的取证锚点。无对应 result 行 = 该 op 被会话终局
   * 收割（killed/halt/end），由 session_end 行解释。envelope.sessionId 寻
   * 文件，未知会话抛错（与 logOp 同一 fail-loud 规则）。 */
  logOpStart(envelope: Mecha.MechaOpEnvelope): void {
    this.write(envelope.sessionId, { kind: 'op_request', envelope });
  }

  /** op 审计行（ExecutorLogger 结构满足，R8 每 op 恰一次）：envelope.sessionId
   * 寻文件，未知会话抛错——审计行绝不静默丢弃。 */
  logOp(envelope: Mecha.MechaOpEnvelope, result: Mecha.MechaOpResult): void {
    this.write(envelope.sessionId, { kind: 'op', envelope, result });
  }

  /** 确认审计行：request + result 同行成对（result 兼容 plain 结果与
   * session 包装层的 confirmEnd 标记结算）。 */
  logConfirm(req: Mecha.MechaConfirmRequest, result: MechaConfirmSettlement): void {
    this.writeCurrent('logConfirm', { kind: 'confirm', request: req, result });
  }

  /** policy.update 记账行：frame + applied（含被拒更新，全量记账）。 */
  logPolicyUpdate(frame: MechaPolicyUpdateFrame, applied: boolean): void {
    this.writeCurrent('logPolicyUpdate', { kind: 'policy_update', frame, applied });
  }

  /** 生命周期行：自由事件名 + 可选 detail（undefined 不落键）。 */
  logLifecycle(event: string, detail?: unknown): void {
    this.writeCurrent('logLifecycle', { kind: 'lifecycle', event, detail });
  }

  /** 会话合卷：落 session_end 行（恒末行）→ 关 fd → 摘表清位。未开始/已结束
   * no-throw（daemon 重启边缘幂等）。写失败抛出时 fd 仍在表（可重试合卷）。 */
  endSession(reason: Mecha.MechaSessionEndReason): void {
    const sessionId = this.currentSessionId;
    if (sessionId === null) return;
    this.write(sessionId, { kind: 'session_end', reason });
    fs.closeSync(this.fds.get(sessionId)!); // write 成功才走到此；不变量保证非空
    this.fds.delete(sessionId);
    this.currentSessionId = null;
  }

  /** 日志文件：`<logsDir>/<sessionId>.jsonl`。 */
  private fileFor(sessionId: string): string {
    return path.join(this.logsDir, `${sessionId}.jsonl`);
  }

  /** 追加一行（fail-loud）：会话未知 / write 失败 / 序列化失败一律抛——
   * 审计行绝不静默丢弃。timestamp ISO string 前置，一行一 JSON。 */
  private write(sessionId: string, line: DashcamLine): void {
    const fd = this.fds.get(sessionId);
    if (fd === undefined) {
      throw new Error(
        `DashcamLogger: session ${JSON.stringify(sessionId)} 未开始（审计行绝不静默丢弃）`,
      );
    }
    const record = JSON.stringify({ timestamp: new Date().toISOString(), ...line });
    fs.writeFileSync(fd, `${record}\n`); // 写满才返回；O_APPEND 行缓冲追加，已落行不撕裂
  }

  /** 落当前会话（协议帧无 sessionId 字段的确认/记账/生命周期行）。 */
  private writeCurrent(api: string, line: DashcamLine): void {
    if (this.currentSessionId === null) {
      throw new Error(
        `DashcamLogger.${api}: 无进行中会话（审计行绝不静默丢弃——beginSession 先行）`,
      );
    }
    this.write(this.currentSessionId, line);
  }
}
