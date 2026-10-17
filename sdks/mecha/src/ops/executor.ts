import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { Mecha } from '@clawrent/protocol';
import {
  realpathCanonical,
  resolveWithinWhitelist,
  type PathGuardResult,
} from '../enforcement/path-guard.js';
import { computeTier, type ConfirmTierDenyCode } from '../enforcement/confirm-tier.js';
import { matchProgram, type ProgramGuardResult } from '../enforcement/program-guard.js';
import type { ProvenanceStore } from '../enforcement/provenance.js';

/**
 * 机甲执行器（plan Task 10/11）：驾驶原语的强制执行点——把 T6 path-guard、
 * T7 program-guard、T8 provenance、T9 confirm-tier 四道护栏串成每个 op 的
 * 实际执行流。九原语全覆盖（fs.* / file.upload / exec.run）。
 *
 * 单 op 执行流（顺序即语义，不可调换）：
 *
 *   1. computeTier 判级 —— { deny } → 直接拒（硬拒不弹确认，信息量最小）；
 *      exec.run 的 argv[0] 先经 matchProgram 求好（判级①依赖其产物）；
 *   2. 硬边界校验（全部先于人工确认）——
 *      fs.* 与 exec.run 的 cwd 路径过 resolveWithinWhitelist（越界 =
 *      PATH_DENIED，白名单是硬边界，**确认不可放行**，先拒免浪费一次人审）；
 *      file.upload 名字硬校验；大小超 maxFileBytes = SIZE_LIMIT（spec §5.5
 *      硬限额，同理先拒）；exec.run 另有单槽并发断言（busy → IO_ERROR）；
 *   3. T0 → 直接执行；T1/T2 → requireConfirm（T2 在 T1 同一条通路上把红卡
 *      披露语前置进 summary），拒 → CONFIRM_DENIED，**此前无任何写动作**
 *      （部分副作用零容忍）；
 *   4. 执行：fs.* 一律作用于 path-guard 返回的 `real`（TOCTOU 契约，检查
 *      对象即操作对象，绝不拿输入字符串二次解析）；exec.run 以 matchProgram
 *      产物 absPath 作 argv[0]、argv.slice(1) 原样直达 spawn——**绝不经
 *      shell**（无管道/替换/转义逃逸面）；fs.write / file.upload 完成即
 *      provenance.record(real, sha256)；fs.copy / fs.move 目的地同样入溯源
 *      （R11 收口：目录目的地逐文件登记，洗白链收口裁定——upload → copy
 *      改名 → exec 新名不得把 T2 红卡洗成 T1）。
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
 * exec.run 执行契约（plan Task 11）：
 *  - spawn(absPath, argv.slice(1), { cwd, env, windowsHide: true })，POSIX
 *    另设 detached: true（子进程独立进程组，负 pid 组杀可达）；
 *  - 超时 = min(op.timeoutMs ?? execTimeoutDefaultMs, execTimeoutMaxMs)，
 *    到点杀进程树（Windows `taskkill /PID <pid> /T /F`；POSIX
 *    kill(-pid, SIGKILL)），结果 EXEC_TIMEOUT + value.killed；
 *  - stdout/stderr 以 MechaExecChunk 流出（deps.onChunk 注入，session T12
 *    接中继；缺省丢弃，仅保留尾部）——utf8 经 string_decoder 跨块累积
 *    （多字节切片不裂）；seq 每流从 0 严格递增；
 *  - 结果 value 每流只保有界 tail（末 64KB）——全量早已经 onChunk 流出，
 *    op 结果帧不得被巨量输出撑爆；
 *  - env 最小化（R13 裁定）：基座只取系统 PATH + win32 进程初始化必需项，
 *    再并 op.env——守护进程自身 env **绝不**继承（凭证零泄漏）；
 *  - 同一时刻仅 1 个 exec：第二并发 exec.run 在判级后立即 IO_ERROR
 *    'exec busy'（串行队列由 session 层保证，此处是第二道墙）；
 *  - killActiveExec() 暴露给 session（T12 链路断开时调用）：杀运行中 exec
 *    的进程树并令其结果带 killed 标记。
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
  /** exec.run 流式回传 sink（Task 12 接中继通道）。缺省时流块丢弃、结果仍
   * 保有界 tail——executor 不因 sink 缺席而拒绝执行。回调抛错被吞（中继故障
   * 不炸守护进程、不回改 op 结果）。 */
  onChunk?: (chunk: Mecha.MechaExecChunk) => void;
}

// 协议单一事实源取码（风格随 T6/T7：协议七码若变动，此处编译期即报错）。
const PATH_DENIED: 'PATH_DENIED' = Mecha.MECHA_ERROR_CODES[0];
const PROGRAM_DENIED: 'PROGRAM_DENIED' = Mecha.MECHA_ERROR_CODES[1];
const CONFIRM_DENIED: 'CONFIRM_DENIED' = Mecha.MECHA_ERROR_CODES[2];
const EXEC_TIMEOUT: 'EXEC_TIMEOUT' = Mecha.MECHA_ERROR_CODES[4];
const SIZE_LIMIT: 'SIZE_LIMIT' = Mecha.MECHA_ERROR_CODES[5];
const IO_ERROR: 'IO_ERROR' = Mecha.MECHA_ERROR_CODES[6];

/** 判级硬拒的人话 message（executor 自产的 PATH_DENIED 同表复用）。 */
const DENY_MESSAGE: Record<ConfirmTierDenyCode, string> = {
  PATH_DENIED: '路径越界：目标不在白名单目录内',
  PROGRAM_DENIED: '程序不在白名单内：拒绝执行',
};

/** fs ops 判级不读 program（computeTier 仅 exec 分支消费该产物）——占位值
 * 只为类型完备，fs/upload 分支永不读它。 */
const PROGRAM_NOT_CONSULTED: ProgramGuardResult = { ok: true, absPath: '' };

/** T2 红卡披露语（Controller 裁定 verbatim）：exec 红卡确认摘要的前置行。 */
const EXEC_T2_DISCLOSURE =
  '红卡警告：此程序将以你的系统账户权限执行任意逻辑，包括读取你账户可读的任何文件并联网发送。';

/** exec 结果每流有界 tail 上限（字节）。全量输出已经 onChunk 流出，op 结果
 * 帧只保尾部供审计——64KB 足以覆盖常见报错尾段，又给结果帧封顶。 */
const EXEC_TAIL_BYTES = 64 * 1024;

/** 确认摘要里 argv 展示上限（字符）。schema 未限 argv 长度，巨量参数只截
 * 展示、不影响执行（spawn 仍收全量 argv）。 */
const EXEC_SUMMARY_ARGV_MAX = 2_000;

/** argv 的确认摘要展示形：空格连接，超限截断加省略标记。 */
function boundedArgvDisplay(argv: string[]): string {
  const joined = argv.join(' ');
  if (joined.length <= EXEC_SUMMARY_ARGV_MAX) return joined;
  return `${joined.slice(0, EXEC_SUMMARY_ARGV_MAX)}…（截断展示）`;
}

/** 目录树登记时文件不可读的哨兵哈希：溯源判红只查路径（isDriverAuthored），
 * 路径必须入红链（宁可误红不可漏红），内容无证则以哨兵明示「有路径无证」。 */
const UNREADABLE_HASH = 'unreadable';

/** exec 进程运行态（busy 槽与 killActiveExec 的共享句柄）。 */
interface ActiveExec {
  child: ChildProcess;
  killed: boolean;
  /** 杀因：timeout（EXEC_TIMEOUT）/ external（killActiveExec）——EXEC_TIMEOUT
   * 码语义只归超时，外部收割以 IO_ERROR 表达。 */
  killReason: 'timeout' | 'external' | null;
}

/**
 * 进程树收割（跨平台，plan 钉死机制）：Windows `taskkill /PID <pid> /T /F`
 * （/T 连子树、/F 强杀）；POSIX 子进程以 detached 起独立进程组，负 pid
 * SIGKILL 组杀（孙进程一并）。组杀失败（组已散/权限）回退直杀。taskkill
 * spawn 同样 windowsHide + 免 shell；fire-and-forget——收割是否生效由
 * close 事件兜底（execRun 内另有补刀看门狗）。
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      /* spawn 同步失败罕见；child.kill 兜底 */
    }
    try {
      child.kill();
    } catch {
      /* 已退出 */
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已退出 */
      }
    }
  }
}

/**
 * exec 子进程 env 构建（Controller ruling R13，binding）：基座只取系统级
 * PATH 与 win32 进程初始化必需项（SystemRoot——node/ws2_32 初始化必需；
 * windir/ComSpec/TEMP/TMP——Windows 程序高频依赖的系统级便利项，均非凭证），
 * 再并 op.env。守护进程自身 env **绝不**继承——daemon 的 token/密钥不得经
 * 子进程 env 外泄（R13 红线）。
 */
function buildExecEnv(opEnv: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  const win32Keys =
    process.platform === 'win32'
      ? ['SystemRoot', 'windir', 'ComSpec', 'TEMP', 'TMP']
      : [];
  for (const key of ['PATH', ...win32Keys]) {
    const value = process.env[key];
    if (typeof value === 'string') env[key] = value;
  }
  if (opEnv !== undefined) {
    for (const [key, value] of Object.entries(opEnv)) env[key] = value;
  }
  return env;
}

/** fs.list 条目（结果 value 载荷）。size 仅文件携带；dir 不带 size 键。 */
interface FsListEntry {
  path: string;
  name: string;
  kind: 'file' | 'dir';
  size?: number;
}

/** exec.run 结果 value 载荷：exitCode 恒在（信号收割归一 -1）；killed 标记
 * 超时/外部收割；tail 仅非空流携带（有界，见 EXEC_TAIL_BYTES）。 */
interface ExecValue {
  exitCode: number;
  killed: boolean;
  stdoutTail?: string;
  stderrTail?: string;
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
 * 机甲执行器（见文件头执行流与裁定）。九原语全覆盖：fs.* + file.upload
 * （Task 10）与 exec.run（Task 11——argv 直达 spawn、流式回传、进程树收割）。
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
    if (op.type === 'exec.run') return this.dispatchExec(op, envelope);

    const tier = computeTier(op, {
      // fs.* / file.upload 判级不读 program（computeTier 仅 exec 分支用）。
      program: PROGRAM_NOT_CONSULTED,
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
      default: {
        // 穷尽哨兵（风格随 T9）：原语全覆盖，schema 外形状响亮失败
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
   * exec.run 分发（Task 11）。判级前先做两件求值（均无副作用、不拒绝——deny
   * 仍按「判级硬拒优先」的原顺序返回，错误码优先序不变）：
   *
   *  1. matchProgram（R2/T7：判级①消费其产物）。配置错误（程序表条目
   *     absPath 非绝对）按 matchProgram 契约抛 TypeError → execute 兜底
   *     IO_ERROR（fail-closed，不静默判级）。
   *  2. cwd 归一（R9 基座，binding 补口）：R2 的 argv 溯源解析「按 exec 的
   *     cwd resolve」必须与实际 spawn cwd 同一宇宙——op.cwd 相对时若放任
   *     computeTier 以进程 cwd 为基座解析，溯源查询落错宇宙即漏红（T2 被
   *     洗成 T1：driver 写脚本 → cwd:'.' 执行即绕过红卡）。故判级前把
   *     op.cwd 归一为白名单真实形。cwd 不可判（guard 失败）时以原 op 判级
   *     ——该 op 终将在 execRun 内 PATH_DENIED，判级结果不生效（同 T9 注释
   *     「兜底拒」口径，此处把该兜底做实）。
   */
  private async dispatchExec(
    op: OpOf<'exec.run'>,
    envelope: Mecha.MechaOpEnvelope,
  ): Promise<Mecha.MechaOpResult> {
    // argv[0] schema 恒非空（min(1)）；`?? ''` 仅类型收窄（空串非裸名必拒）
    const program = matchProgram(op.argv[0] ?? '', this.deps.policy().programs);
    const cwd = this.resolveFsPath(op.cwd);
    const opForTier: OpOf<'exec.run'> = cwd.ok ? { ...op, cwd: cwd.real } : op;
    const tier = computeTier(opForTier, {
      program,
      provenance: (realPath) => this.deps.provenance.isDriverAuthored(realPath),
    });
    if (typeof tier !== 'string') {
      return fail(envelope.opId, tier.deny, DENY_MESSAGE[tier.deny]);
    }
    // 判级表若漂移（exec 被判 T0）响亮失败，同上组口径（类型层面收窄 tier）
    if (tier === 'T0') {
      throw new Error('confirm-tier drift: exec.run 判为 T0，执行流要求经确认制');
    }
    // 判级 T1/T2 ⇒ program 必命中（computeTier ①先硬拒）；防御窄化兜底。
    if (!program.ok) {
      return fail(envelope.opId, PROGRAM_DENIED, DENY_MESSAGE.PROGRAM_DENIED, tier);
    }
    return this.execRun(op, envelope, tier, program.absPath, cwd);
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
   * 溯源收口（controller 洗白链裁定 + R11 补全）：copy/move 在目的地新造了
   * driver 控制内容的产物——不登记则 upload → copy 改名 → exec 新名即可把
   * T2 红卡洗成 T1。故动作成功后**无条件**登记目的地：文件目的地按「落盘读
   * 回 sha256」单文件登记（含非溯源源文件——误红方向 fail-safe，与「宁可误
   * 红不可漏红」同谱系）；**目录目的地走 recordTree 逐文件登记**（目录无单
   * 内容哈希，树内每个文件的 read-back sha256 各自入表）。源路径旧条目按
   * append-only 设计保留（旧路径已不存在，惰性键无害，不删）。
   *
   * 读回/登记失败（含 flush）有意上浮 → execute 兜底 IO_ERROR：文件已落
   * 目的地但结果报败——审计链损伤响亮优于静默（同 fs.write 口径）。 */
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
    const st = fs.statSync(to.real);
    if (st.isFile()) {
      this.deps.provenance.record(to.real, sha256Hex(fs.readFileSync(to.real)));
    } else if (st.isDirectory()) {
      this.recordTree(to.real);
    }
    return { opId: envelope.opId, ok: true, tier, value: { path: to.real } };
  }

  /**
   * 目录树逐文件登记（R11 收口）：walk 目的地树，对每个常规文件按「落盘读
   * 回 sha256」登记——目录 copy/move 后树内文件与单文件 copy 同一红链口径
   * （洗白链的目录形态封堵）。与 fs.list 同一符号链接纪律：目录符号链接不
   * 递归（登记范围 = 目的地树本体，链接目标的盘上内容非本次动作所造，登记
   * 链接自身在树内的路径即 fail-safe 收口）；文件符号链接按树内路径登记
   * （哈希读目标内容）。悬空符号链接（无内容可证）跳过；其余单条目读取失
   * 败不静默漏登——以 UNREADABLE_HASH 哨兵登记路径（判红只查路径，红链不
   * 因读回竞态破口），树遍历本身失败照旧上浮响亮报败。
   */
  private recordTree(root: string): void {
    const walk = (dir: string): void => {
      const names = fs.readdirSync(dir).sort();
      for (const name of names) {
        const child = path.join(dir, name);
        const lst = fs.lstatSync(child);
        let st = lst;
        if (lst.isSymbolicLink()) {
          try {
            st = fs.statSync(child); // 跟随分类；悬空（ENOENT）→ 无内容可证，跳过
          } catch {
            continue;
          }
        }
        if (st.isDirectory()) {
          if (!lst.isSymbolicLink()) walk(child); // 目录符号链接不递归（同 fs.list 纪律）
          continue;
        }
        if (!st.isFile()) continue; // 设备/_fifo 等非常规条目不登记
        let hash: string;
        try {
          hash = sha256Hex(fs.readFileSync(child));
        } catch {
          hash = UNREADABLE_HASH; // 读回竞态（ACL/删改）：路径仍入红链（fail-safe）
        }
        this.deps.provenance.record(child, hash);
      }
    };
    walk(root);
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

  // ── exec.run（Task 11）────────────────────────────────────────────────────

  /** exec 单槽并发断言层（第二道墙：串行队列由 session 层保证）。覆盖整个
   * execRun 生命周期（含确认等待）——同一时刻仅 1 个 exec op 在途。 */
  private execBusy = false;

  /** 运行中的 exec（spawn 后非空）：killActiveExec 的收割句柄与 killed/杀因
   * 共享态。 */
  private activeExec: ActiveExec | null = null;

  /** 杀运行中 exec 的进程树并令其结果带 killed 标记（session T12 链路断开
   * 时调用；无运行中 exec 时为无害 no-op）。 */
  killActiveExec(): void {
    const active = this.activeExec;
    if (active === null) return;
    active.killed = true;
    active.killReason = 'external';
    killProcessTree(active.child);
  }

  /** exec.run 单槽闸 + 生命周期兜底：finally 无条件释放槽位；spawn 成功后若
   * 因任何未预期异常中途退出，补杀进程树（绝不留下孤儿进程）。cwd 为
   * dispatchExec 已求值的 guard（单次判定，TOCTOU 契约同 fs.*）。 */
  private async execRun(
    op: OpOf<'exec.run'>,
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
    absPath: string,
    cwd: PathGuardResult,
  ): Promise<Mecha.MechaOpResult> {
    if (this.execBusy) {
      return fail(envelope.opId, IO_ERROR, 'exec busy');
    }
    this.execBusy = true;
    try {
      return await this.execRunLocked(op, envelope, tier, absPath, cwd);
    } finally {
      this.execBusy = false;
      const active = this.activeExec;
      this.activeExec = null;
      if (active !== null && active.child.exitCode === null && !active.child.killed) {
        killProcessTree(active.child); // 未预期异常路径的孤儿进程兜底
      }
    }
  }

  private async execRunLocked(
    op: OpOf<'exec.run'>,
    envelope: Mecha.MechaOpEnvelope,
    tier: 'T1' | 'T2',
    absPath: string,
    cwd: PathGuardResult,
  ): Promise<Mecha.MechaOpResult> {
    const { opId } = envelope;
    // cwd 硬边界先于确认（白名单确认不可放行；判级时已归一，deny 落在此处）
    if (!cwd.ok) return fail(opId, PATH_DENIED, DENY_MESSAGE.PATH_DENIED, tier);
    // 超时：缺省取策略默认，显式值钳到 max（policy.update tighten 立即生效
    // ——每 op 现取，不缓存）
    const limits = this.deps.policy().limits;
    const timeoutMs =
      op.timeoutMs === undefined
        ? limits.execTimeoutDefaultMs
        : Math.min(op.timeoutMs, limits.execTimeoutMaxMs);
    // 确认：T2 在 T1 同一通路上把红卡披露语前置进 summary（人审看得到才叫
    // 披露）。argv 展示有界（schema 未限 argv 长度——巨量参数不得撑爆确认
    // 帧与行车记录；截断只影响展示尾部，披露语与工作目录恒在）。
    const baseSummary = `驾驶员想执行 ${boundedArgvDisplay(op.argv)}（工作目录 ${cwd.real}）`;
    const summary =
      tier === 'T2' ? `${EXEC_T2_DISCLOSURE}\n${baseSummary}` : baseSummary;
    const denied = await this.requireConfirm(envelope, tier, summary);
    if (denied) return denied;

    const child = spawn(absPath, op.argv.slice(1), {
      cwd: cwd.real,
      env: buildExecEnv(op.env),
      windowsHide: true,
      // POSIX：独立进程组——负 pid 组杀（killProcessTree）可收割孙进程；
      // Windows 组杀走 taskkill /T，不需要（也不想要）新控制台语义。
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], // 驱动无 stdin 通道（op schema 无此面）
    });
    const active: ActiveExec = { child, killed: false, killReason: null };
    this.activeExec = active;

    // 流式接线：每流独立 StringDecoder（utf8 多字节跨块切片不裂）+ seq 计数
    // + 有界 tail 累积。sink 缺席时流块丢弃（结果 tail 仍在）。
    const tails: Record<'stdout' | 'stderr', Buffer> = {
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
    const seq: Record<'stdout' | 'stderr', number> = { stdout: 0, stderr: 0 };
    const decoders: Record<'stdout' | 'stderr', StringDecoder> = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    };
    const wire = (stream: 'stdout' | 'stderr'): void => {
      const pipe = stream === 'stdout' ? child.stdout : child.stderr;
      if (pipe === null) return;
      pipe.on('data', (buf: Buffer) => {
        tails[stream] = Buffer.concat([tails[stream], buf]).subarray(-EXEC_TAIL_BYTES);
        const text = decoders[stream].write(buf);
        if (text.length > 0) this.emitChunk(opId, stream, text, seq[stream]++);
      });
    };
    wire('stdout');
    wire('stderr');

    // 超时杀树 + 生命周期收束。killed 后 close 若迟迟不来（收割失效/僵尸），
    // 看门狗每 5s 补刀、15s 强制收束——「每 op 必有结果」不允许挂死。结局经
    // Promise 分辨率携带（不用闭包外变量——CFA 不追踪回调内赋值）。
    const timer = setTimeout(() => {
      active.killed = true;
      active.killReason = 'timeout';
      killProcessTree(child);
    }, timeoutMs);
    const outcome = await new Promise<{
      spawnError: Error | null;
      exitCode: number | null;
    }>((resolve) => {
      let settled = false;
      let watchdog: NodeJS.Timeout | null = null;
      const start = Date.now();
      const finish = (result: { spawnError: Error | null; exitCode: number | null }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (watchdog !== null) clearInterval(watchdog);
        resolve(result);
      };
      child.once('error', (err) => {
        // ENOENT 类（登记真身不存在/工作目录不可达）走此处
        finish({ spawnError: err, exitCode: null });
      });
      child.once('close', (code) => {
        finish({ spawnError: null, exitCode: code });
      });
      // 补刀看门狗：killed 后 close 迟迟不来（收割失效/僵尸）——每 5s 重杀，
      // 15s 强制收束（每 op 必有结果，不允许挂死）
      watchdog = setInterval(() => {
        if (!active.killed) return;
        killProcessTree(child);
        if (Date.now() - start >= 15_000) finish({ spawnError: null, exitCode: null });
      }, 5_000);
    });
    // 尾块冲刷：decoder 缓冲的残留字节（跨块多字节尾/无换行尾段）补发
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = decoders[stream].end();
      if (rest.length > 0) this.emitChunk(opId, stream, rest, seq[stream]++);
    }

    if (outcome.spawnError !== null) {
      return fail(
        opId,
        IO_ERROR,
        `exec 启动失败（程序不存在或工作目录不可达）: ${outcome.spawnError.message}`,
        tier,
      );
    }
    // 信号收割无 exitCode → -1（非 0 口径钉死：killed 进程绝不伪装正常退出）
    const exit = outcome.exitCode ?? -1;
    const value: ExecValue = { exitCode: exit, killed: active.killed };
    if (tails.stdout.length > 0) value.stdoutTail = tails.stdout.toString('utf8');
    if (tails.stderr.length > 0) value.stderrTail = tails.stderr.toString('utf8');
    if (active.killed) {
      return active.killReason === 'timeout'
        ? { opId, ok: false, tier, value, error: { code: EXEC_TIMEOUT, message: `执行超过 ${timeoutMs}ms，进程树已被终止` } }
        : { opId, ok: false, tier, value, error: { code: IO_ERROR, message: 'exec 已被会话终止（进程树已收割）' } };
    }
    return { opId, ok: true, tier, value };
  }

  /** exec 流块下发：sink 注入回调包一层吞错（中继故障不炸守护进程、不回改
   * op 结果——同 logOp 尽力而为口径）。 */
  private emitChunk(
    opId: string,
    stream: 'stdout' | 'stderr',
    data: string,
    seq: number,
  ): void {
    const onChunk = this.deps.onChunk;
    if (onChunk === undefined) return;
    try {
      onChunk({ opId, stream, data, seq });
    } catch {
      // 尽力而为：见函数头
    }
  }
}
