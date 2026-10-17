import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Mecha } from '@clawrent/protocol';
import {
  realpathCanonical,
  resolveWithinWhitelist,
  type PathGuardResult,
} from '../enforcement/path-guard.js';
import { computeTier, type ConfirmTierDenyCode } from '../enforcement/confirm-tier.js';
import type { ProgramGuardResult } from '../enforcement/program-guard.js';
import type { ProvenanceStore } from '../enforcement/provenance.js';

/**
 * 机甲执行器（plan Task 10）：驾驶原语的强制执行点——把 T6 path-guard、T8
 * provenance、T9 confirm-tier 三道护栏串成每个 op 的实际执行流。本文件只落
 * fs.* 与 file.upload；exec.run 由 Task 11 在 dispatch 处接线。
 *
 * 单 op 执行流（顺序即语义，不可调换）：
 *
 *   1. computeTier 判级 —— { deny } → 直接拒（硬拒不弹确认，信息量最小）；
 *   2. 硬边界校验（全部先于人工确认）——
 *      fs.* 路径过 resolveWithinWhitelist（越界 = PATH_DENIED，白名单是硬
 *      边界，**确认不可放行**，先拒免浪费一次人审）；file.upload 名字硬校验；
 *      大小超 maxFileBytes = SIZE_LIMIT（spec §5.5 硬限额，同理先拒）；
 *   3. T0 → 直接执行；T1/T2 → requireConfirm（T2 与 T1 同一条确认通路，无
 *      特判——未来 exec 红卡复用），拒 → CONFIRM_DENIED，**此前无任何写动作**
 *      （部分副作用零容忍）；
 *   4. 执行：一律作用于 path-guard 返回的 `real`（TOCTOU 契约，检查对象即
 *      操作对象，绝不拿输入字符串二次解析）；fs.write / file.upload 完成
 *      即 provenance.record(real, sha256)；fs.copy / fs.move 目的地同样入
 *      溯源（洗白链收口裁定：upload → copy 改名 → exec 新名不得把 T2 红
 *      卡洗成 T1）。
 *
 * fs.* 相对路径解析基座（Controller ruling R9，binding）：一律按**首个白名
 * 单目录**解析——「驾驶员的工作目录 = 首个白名单目录」的确定性心智模型，
 * 不引入进程 cwd 这第二个解析基座。白名单为空 / 首项非绝对（运行期脏
 * policy）→ fail-closed 全拒（返回 PATH_DENIED，不抛——判级与路径边界一律
 * 以协议七码结果表达，不炸守护进程）。
 *
 * file.upload 名字契约：必须是纯文件名——禁分隔符（/ 与 \）、禁点段
 * （`.`/`..`）、禁冒号（盘符 `C:x` 与 NTFS ADS `a:b` 同源，一并拒）——违规
 * 返回 IO_ERROR 'invalid upload name'。目标 = `join(scratchDir, name)`，
 * scratchDir 由 session 注入（R1 裁定构造参数；spec §5.6：upload 是驾驶员
 * 工具/脚本的唯一写入通道，落点即焚区，不入白名单校验）。
 *
 * fs.list 的 glob 自实现（无新依赖裁定）：仅 `*`（段内任意，不跨 `/`）与
 * `**`（零或多层目录，收尾 `**` = 任意非空相对路径）；depth 语义 = 额外
 * 展开层数（0 = 仅本层，schema 默认）。**符号链接目录一律不递归**——白名单
 * 根过 guard 不代表其子符号链接也指界内，顺着 readdir 即白名单外读；符号
 * 链接条目本身照常列出（按跟随后的目标类型分类），逐路径的 fs.read 仍各自
 * 过 guard（fail-closed：列表给名字，访问给边界）。
 *
 * 错误兜底：单 op 任何未预期异常（含判级穷尽哨兵、fs errno）→ IO_ERROR
 * 结果返回——executor 的契约是「每 op 必有结果」，绝不向 session/驱动通道
 * 抛异常。confirm 回调自身抛错（通道故障）同路径兜底；CONFIRM_TIMEOUT 由
 * session 层（Task 12）以超时拒绝注入，本层只 await。
 *
 * 行车记录（Controller ruling R8，binding）：每 op 结束恰好一次
 * `log.logOp(envelope, result)`（结果帧即审计载荷——成功/失败/拒绝全量；
 * 确认与否从 result error 可见，不另设 logConfirm 依赖）。日志器故障吞掉
 * 不回改 op 结果（尽力而为；日志器自身健壮性归 Task 13）。
 */

/** 行车记录最小接口（R8 裁定）：Task 13 DashcamLogger 结构满足之，避免
 * executor 前向依赖 logging 模块。 */
export interface ExecutorLogger {
  logOp(envelope: Mecha.MechaOpEnvelope, result: Mecha.MechaOpResult): void;
}

/** executor 依赖注入（R1 裁定：scratchDir 构造参数，Task 12 session 接线）。 */
export interface MechaExecutorDeps {
  /** 会话策略取值器：每 op 现取——policy.update tighten 立即生效的前提。 */
  policy: () => Mecha.MechaPolicy;
  provenance: ProvenanceStore;
  confirm: (req: Mecha.MechaConfirmRequest) => Promise<Mecha.MechaConfirmResult>;
  log: ExecutorLogger;
  /** 会话暂存区绝对路径（file.upload 唯一落点；spec §5.6 即焚区）。 */
  scratchDir: string;
}

// 协议单一事实源取码（风格随 T6/T7：协议七码若变动，此处编译期即报错）。
const PATH_DENIED: 'PATH_DENIED' = Mecha.MECHA_ERROR_CODES[0];
const PROGRAM_DENIED: 'PROGRAM_DENIED' = Mecha.MECHA_ERROR_CODES[1];
const CONFIRM_DENIED: 'CONFIRM_DENIED' = Mecha.MECHA_ERROR_CODES[2];
const SIZE_LIMIT: 'SIZE_LIMIT' = Mecha.MECHA_ERROR_CODES[5];
const IO_ERROR: 'IO_ERROR' = Mecha.MECHA_ERROR_CODES[6];

/** 判级硬拒的人话 message（executor 自产的 PATH_DENIED 同表复用）。 */
const DENY_MESSAGE: Record<ConfirmTierDenyCode, string> = {
  PATH_DENIED: '路径越界：目标不在白名单目录内',
  PROGRAM_DENIED: '程序不在白名单内：拒绝执行',
};

/** exec.run 占位程序表结果（v0 未接线，Task 11 以 matchProgram 实接替换）：
 * 恒拒形状——exec.run 提前抵达时在 computeTier ①即 PROGRAM_DENIED 硬拒，
 * 绝不落到执行分发（fail-closed：未实现的原语宁可全拒，不可半执行）。 */
const EXEC_UNWIRED: ProgramGuardResult = { ok: false, code: 'PROGRAM_DENIED' };

/** fs.list 条目（结果 value 载荷）。size 仅文件携带；dir 不带 size 键。 */
interface FsListEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size?: number;
}

/** 失败结果（tier 仅 T1/T2 op 携带，供审计；T0/deny 不带）。 */
function fail(
  opId: string,
  code: Mecha.MechaErrorCode,
  message: string,
  tier?: 'T1' | 'T2',
): Mecha.MechaOpResult {
  return tier === undefined
    ? { opId, ok: false, error: { code, message } }
    : { opId, ok: false, tier, error: { code, message } };
}

/** SIZE_LIMIT 人话 message。 */
function sizeMessage(bytes: number, max: number): string {
  return `内容 ${bytes} 字节，超过单文件上限 ${max} 字节`;
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * file.upload 名字硬校验：纯文件名（见文件头契约）。`:` 整拒同时覆盖盘符
 * 相对形态（`C:x`）与 NTFS ADS（`a:b`）——upload 名字应平台可移植，冒号在
 * 任一侧都不是可移植文件名。
 */
function isValidUploadName(name: string): boolean {
  if (name === '' || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name.includes(':')) return false;
  return true;
}

/**
 * 最小 glob 匹配（无新依赖）：段内 `*` → `[^/]*`；独立 `**` 段 → 零或多层
 * 目录（吞掉其后的分隔符；收尾 `**` = 任意非空相对路径）。空段与 `.` 段
 * 容忍剔除。仅此两符——`?`/`[...]` 等 v0 不支持（按字面处理）。
 */
function globToRegExp(glob: string): RegExp {
  const segs = glob.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  let src = '';
  segs.forEach((seg, i) => {
    const last = i === segs.length - 1;
    if (seg === '**') {
      src += last ? '[^/]+(?:/[^/]+)*' : '(?:[^/]+/)*';
      return;
    }
    src += seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    if (!last) src += '/';
  });
  return new RegExp(`^${src}$`);
}

/**
 * fs.list 遍历（见文件头 depth/glob/symlink 语义）。子条目 lstat 失败（ACL/
 * 竞态）仅跳过该条目；根目录 readdir 失败向上抛（→ IO_ERROR 整单失败，响亮
 * 优于静默空表）。同级按名字排序保证结果确定性。
 */
function listTree(root: string, depth: number, matcher: RegExp | null): FsListEntry[] {
  const entries: FsListEntry[] = [];
  const walk = (dir: string, rel: string, level: number): void => {
    const names = fs.readdirSync(dir).sort();
    for (const name of names) {
      const child = path.join(dir, name);
      const childRel = rel === '' ? name : `${rel}/${name}`;
      let lst: fs.Stats;
      try {
        lst = fs.lstatSync(child);
      } catch {
        continue; // 单条目不可判定：跳过（列表尽提示不阻塞整单）
      }
      let st = lst;
      if (lst.isSymbolicLink()) {
        try {
          st = fs.statSync(child); // 跟随分类（目标类型）；悬空则保留 lstat 形
        } catch {
          /* 悬空符号链接：按 file 报、无 size */
        }
      }
      const entry: FsListEntry = {
        path: child,
        name,
        kind: st.isDirectory() ? 'dir' : 'file',
      };
      if (st.isFile()) entry.size = st.size;
      if (matcher === null || matcher.test(childRel)) entries.push(entry);
      // 符号链接目录不递归（白名单逃逸面，见文件头）；未达深度上限才展开
      if (st.isDirectory() && !lst.isSymbolicLink() && level <= depth) {
        walk(child, childRel, level + 1);
      }
    }
  };
  walk(root, '', 1);
  return entries;
}

/** 驾驶原语 handler 的 op 精确类型。 */
type OpOf<T extends Mecha.MechaOp['type']> = Extract<Mecha.MechaOp, { type: T }>;

/**
 * 机甲执行器（见文件头执行流与裁定）。fs.* 与 file.upload 归本类；exec.run
 * 由 Task 11 接线（占位期 PROGRAM_DENIED 硬拒）。
 */
export class MechaExecutor {
  constructor(private readonly deps: MechaExecutorDeps) {
    // 配置错误 fail-closed（风格随 T6 cwd/T8 file 的绝对路径契约）：scratchDir
    // 相对会让 upload 落点随进程 cwd 漂移、且溯源登记不可复现，构造即响亮失败。
    if (!path.isAbsolute(deps.scratchDir)) {
      throw new TypeError(
        `MechaExecutor: scratchDir 必须为绝对路径，收到 ${JSON.stringify(deps.scratchDir)}`,
      );
    }
  }

  /** 执行一个驾驶 op：每 op 必有结果（异常兜底 IO_ERROR），每 op 恰好一条
   * logOp（含失败/拒绝——结果帧即审计载荷）。 */
  async execute(envelope: Mecha.MechaOpEnvelope): Promise<Mecha.MechaOpResult> {
    let result: Mecha.MechaOpResult;
    try {
      result = await this.dispatch(envelope);
    } catch (err) {
      // 单 op 异常绝不炸守护进程/断驱动连接：转 IO_ERROR 结果返回（fail-safe）
      result = fail(
        envelope.opId,
        IO_ERROR,
        err instanceof Error ? err.message : String(err),
      );
    }
    try {
      this.deps.log.logOp(envelope, result);
    } catch {
      // 行车记录尽力而为：日志器故障不回改已发生的 op 结果（T13 管日志器健壮性）
    }
    return result;
  }

  private async dispatch(
    envelope: Mecha.MechaOpEnvelope,
  ): Promise<Mecha.MechaOpResult> {
    const { op } = envelope;
    const tier = computeTier(op, {
      // fs.* / file.upload 判级不读 program（computeTier 仅 exec 分支用）；
      // 占位 stub 见 EXEC_UNWIRED 注释。
      program: EXEC_UNWIRED,
      provenance: (realPath) => this.deps.provenance.isDriverAuthored(realPath),
    });
    if (typeof tier !== 'string') {
      return fail(envelope.opId, tier.deny, DENY_MESSAGE[tier.deny]);
    }

    // T0 免确认组（判级表：fs.list/fs.read）
    switch (op.type) {
      case 'fs.list':
        return this.fsList(op, envelope.opId);
      case 'fs.read':
        return this.fsRead(op, envelope.opId);
    }

    // T1/T2 经确认制组（判级表：其余 fs.* 与 file.upload 恒 T1）。判级表若
    // 漂移（某写原语被降 T0）在此响亮失败而非静默免确认执行（throw 被
    // execute 兜底为 IO_ERROR 结果——op 不执行）；类型层面同时收窄 tier。
    if (tier === 'T0') {
      throw new Error(`confirm-tier drift: ${op.type} 判为 T0，执行流要求经确认制`);
    }

    switch (op.type) {
      case 'fs.write':
        return this.fsWrite(op, envelope, tier);
      case 'fs.mkdir':
        return this.fsMkdir(op, envelope, tier);
      case 'fs.move':
        return this.fsMove(op, envelope, tier);
      case 'fs.copy':
        return this.fsCopy(op, envelope, tier);
      case 'fs.delete':
        return this.fsDelete(op, envelope, tier);
      case 'file.upload':
        return this.fileUpload(op, envelope, tier);
      case 'exec.run':
        // 不可达（EXEC_UNWIRED 恒拒在判级层短路）——Task 11 以 matchProgram
        // 实接后此分支成为真入口。
        return fail(envelope.opId, PROGRAM_DENIED, DENY_MESSAGE.PROGRAM_DENIED, tier);
      default: {
        // 穷尽哨兵（风格随 T9）：九原语全覆盖，schema 外形状响亮失败
        const exhaustive: never = op;
        return fail(
          envelope.opId,
          IO_ERROR,
          `unsupported op type: ${(exhaustive as Mecha.MechaOp).type}`,
        );
      }
    }
  }

  /**
   * fs.* 路径白名单判定（TOCTOU 契约：调用方只能用返回的 `real` 执行 op）。
   * R9 裁定：相对路径一律按首个白名单目录解析。白名单空/首项非绝对（运行
   * 期脏 policy）→ fail-closed 全拒，不抛（见文件头）。
   */
  private resolveFsPath(input: string): PathGuardResult {
    const base = this.deps.policy().dirs[0];
    if (base === undefined || !path.isAbsolute(base)) {
      return { ok: false, code: PATH_DENIED };
    }
    return resolveWithinWhitelist(input, base, this.deps.policy().dirs);
  }

  private maxFileBytes(): number {
    return this.deps.policy().limits.maxFileBytes;
  }

  /** T1/T2 统一确认闸（T2 与 T1 同路，无特判；未来 exec 分支复用）。批准返
   * 回 null；拒绝返回 CONFIRM_DENIED 结果。契约：调用方在 requireConfirm 之
   * 前不得有任何写动作（部分副作用零容忍）。requestId 稳定方案 = opId +
   * ':confirm'（v0 每 op 至多一次确认）。 */
  private async requireConfirm(
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
    summary: string,
  ): Promise<Mecha.MechaOpResult | null> {
    const decision = await this.deps.confirm({
      requestId: `${envelope.opId}:confirm`,
      opId: envelope.opId,
      tier,
      summary,
    });
    if (decision.approved) return null;
    return fail(envelope.opId, CONFIRM_DENIED, '驾驶员拒绝执行该操作', tier);
  }

  private fsList(op: OpOf<'fs.list'>, opId: string): Mecha.MechaOpResult {
    const guard = this.resolveFsPath(op.path);
    if (!guard.ok) return fail(opId, PATH_DENIED, DENY_MESSAGE.PATH_DENIED);
    const matcher = op.glob === undefined ? null : globToRegExp(op.glob);
    const entries = listTree(guard.real, op.depth ?? 0, matcher);
    return { opId, ok: true, value: entries };
  }

  private fsRead(op: OpOf<'fs.read'>, opId: string): Mecha.MechaOpResult {
    const guard = this.resolveFsPath(op.path);
    if (!guard.ok) return fail(opId, PATH_DENIED, DENY_MESSAGE.PATH_DENIED);
    const max = this.maxFileBytes();
    const size = fs.statSync(guard.real).size; // 不存在 → ENOENT → 外层 IO_ERROR
    if (size > max) return fail(opId, SIZE_LIMIT, sizeMessage(size, max));
    const buf = fs.readFileSync(guard.real);
    // stat→read 间隙文件增长（TOCTOU 残面）：以实读字节数兜底同限
    if (buf.length > max) return fail(opId, SIZE_LIMIT, sizeMessage(buf.length, max));
    return {
      opId,
      ok: true,
      value: {
        content: op.encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8'),
        encoding: op.encoding,
      },
    };
  }

  private async fsWrite(
    op: OpOf<'fs.write'>,
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
  ): Promise<Mecha.MechaOpResult> {
    const guard = this.resolveFsPath(op.path);
    if (!guard.ok) return fail(envelope.opId, PATH_DENIED, DENY_MESSAGE.PATH_DENIED, tier);
    const buf =
      op.encoding === 'base64'
        ? Buffer.from(op.content, 'base64')
        : Buffer.from(op.content, 'utf8');
    const max = this.maxFileBytes();
    if (buf.length > max) {
      return fail(envelope.opId, SIZE_LIMIT, sizeMessage(buf.length, max), tier);
    }
    const denied = await this.requireConfirm(
      envelope,
      tier,
      `驾驶员想写入 ${guard.real}`,
    );
    if (denied) return denied;
    fs.writeFileSync(guard.real, buf);
    // record 抛错（flush 失败）有意上浮 → execute 兜底 IO_ERROR：文件已写但
    // 结果报败——审计链损伤必须响亮（重试同内容同哈希即自愈），不静默吞。
    this.deps.provenance.record(guard.real, sha256Hex(buf));
    return { opId: envelope.opId, ok: true, tier, value: { path: guard.real } };
  }

  private async fsMkdir(
    op: OpOf<'fs.mkdir'>,
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
  ): Promise<Mecha.MechaOpResult> {
    const guard = this.resolveFsPath(op.path);
    if (!guard.ok) return fail(envelope.opId, PATH_DENIED, DENY_MESSAGE.PATH_DENIED, tier);
    const denied = await this.requireConfirm(
      envelope,
      tier,
      `驾驶员想创建目录 ${guard.real}`,
    );
    if (denied) return denied;
    fs.mkdirSync(guard.real, { recursive: true });
    return { opId: envelope.opId, ok: true, tier, value: { path: guard.real } };
  }

  /** fs.move / fs.copy 共流：from/to 双双过 guard（分别真实化），确认后作用于
   * 两个 real。value.path = 目的地 real（新产物的落点）。
   *
   * 溯源收口（controller 洗白链裁定）：copy/move 在目的地新造了 driver 控制
   * 内容的文件——不登记则 upload → copy 改名 → exec 新名即可把 T2 红卡洗成
   * T1。故动作成功后**无条件** record 目的地（含非溯源源文件——误红方向
   * fail-safe，与「宁可误红不可漏红」同谱系）。哈希口径 = 动作后读回目的地
   * 内容求 sha256（「落盘即所证」，copy/move 同一口径，亦天然覆盖 from===to）。
   * 目的地为目录时不登记（目录无单内容哈希；树内逐文件登记超出裁定文本，
   * 残余面已在任务报告声明）。源路径旧条目按 append-only 设计保留（旧路径
   * 已不存在，惰性键无害，不删）。 */
  private async transfer(
    op: OpOf<'fs.move'> | OpOf<'fs.copy'>,
    verb: '移动' | '复制',
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
    act: (from: string, to: string) => void,
  ): Promise<Mecha.MechaOpResult> {
    const from = this.resolveFsPath(op.from);
    if (!from.ok) return fail(envelope.opId, PATH_DENIED, DENY_MESSAGE.PATH_DENIED, tier);
    const to = this.resolveFsPath(op.to);
    if (!to.ok) return fail(envelope.opId, PATH_DENIED, DENY_MESSAGE.PATH_DENIED, tier);
    const denied = await this.requireConfirm(
      envelope,
      tier,
      `驾驶员想把 ${from.real} ${verb}到 ${to.real}`,
    );
    if (denied) return denied;
    act(from.real, to.real);
    // 读回/登记失败（含 flush）有意上浮 → execute 兜底 IO_ERROR：文件已落
    // 目的地但结果报败——审计链损伤响亮优于静默（同 fs.write 口径）。
    if (fs.statSync(to.real).isFile()) {
      this.deps.provenance.record(to.real, sha256Hex(fs.readFileSync(to.real)));
    }
    return { opId: envelope.opId, ok: true, tier, value: { path: to.real } };
  }

  private fsMove(
    op: OpOf<'fs.move'>,
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
  ): Promise<Mecha.MechaOpResult> {
    return this.transfer(op, '移动', envelope, tier, (from, to) =>
      fs.renameSync(from, to),
    );
  }

  private fsCopy(
    op: OpOf<'fs.copy'>,
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
  ): Promise<Mecha.MechaOpResult> {
    return this.transfer(op, '复制', envelope, tier, (from, to) =>
      fs.cpSync(from, to, { recursive: true }),
    );
  }

  private async fsDelete(
    op: OpOf<'fs.delete'>,
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
  ): Promise<Mecha.MechaOpResult> {
    const guard = this.resolveFsPath(op.path);
    if (!guard.ok) return fail(envelope.opId, PATH_DENIED, DENY_MESSAGE.PATH_DENIED, tier);
    const denied = await this.requireConfirm(
      envelope,
      tier,
      `驾驶员想删除 ${guard.real}`,
    );
    if (denied) return denied;
    fs.rmSync(guard.real, { recursive: op.recursive });
    return { opId: envelope.opId, ok: true, tier, value: { path: guard.real } };
  }

  private async fileUpload(
    op: OpOf<'file.upload'>,
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
  ): Promise<Mecha.MechaOpResult> {
    // 名字硬校验先于确认（不可被人工放行的契约面）
    if (!isValidUploadName(op.name)) {
      return fail(envelope.opId, IO_ERROR, 'invalid upload name', tier);
    }
    const buf = Buffer.from(op.content, 'utf8'); // upload schema 无 encoding——内容恒 utf8 文本
    const max = this.maxFileBytes();
    if (buf.length > max) {
      return fail(envelope.opId, SIZE_LIMIT, sizeMessage(buf.length, max), tier);
    }
    const denied = await this.requireConfirm(
      envelope,
      tier,
      `驾驶员想上传 ${op.name} 到会话暂存区`,
    );
    if (denied) return denied;
    fs.mkdirSync(this.deps.scratchDir, { recursive: true });
    const target = path.join(this.deps.scratchDir, op.name);
    fs.writeFileSync(target, buf);
    // 写后真实化：登记/返回盘上真身（scratchDir 若含符号链接段也被归一）
    const real = realpathCanonical(target);
    this.deps.provenance.record(real, sha256Hex(buf));
    return { opId: envelope.opId, ok: true, tier, value: { path: real } };
  }
}
