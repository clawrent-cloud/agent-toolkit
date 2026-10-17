import * as path from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { realpathAllowingTail } from './path-guard.js';
import type { ProgramGuardResult } from './program-guard.js';

/**
 * confirm-tier 判级（spec §5.4 / plan Task 9）：每个驾驶 op 落入哪个确认档
 * ——T0 免确认 / T1 普通卡 / T2 红卡，或 exec 硬拒。**本函数只判级、不执行
 * 任何原语**；fs.* 的路径越界（PATH_DENIED）归 executor 调 path-guard（分层
 * 拒绝——本函数不越权判 fs 路径，白名单校验同样不在本函数）。
 *
 * 判级表（plan verbatim）：
 *  - `fs.list` / `fs.read` → T0（白名单内读，免确认）；
 *  - 其余 fs.*（write/mkdir/move/copy/delete）与 `file.upload` → T1；
 *  - `exec.run`：
 *      ① argv[0] 未命中程序表 → `{ deny: 'PROGRAM_DENIED' }`（ctx.program 已
 *         由 executor 经 matchProgram 求好；硬拒优先于一切判级信号——拒不发
 *         级，硬拒信息量最小）；
 *      ② 解释器内联模式（argv[0] 合法也必须红）→ T2；
 *      ③ argv 任一元素解析为溯源文件 → T2（宁可误红不可漏红；会话 1 写入的
 *         脚本、会话 2 再执行照样红——Review Focus #3）；
 *      ④ 其余 → T1。
 *
 * 溯源解析口径（Controller ruling R2，binding）：argv 非首元素按 exec 的
 * `cwd` resolve 后，用 path-guard 导出的 `realpathAllowingTail` 真实化——
 * 存在（或最长存在前缀+尾段）才查溯源；解析不可判定（非 ENOENT，返回 null）
 * 则跳过该元素的溯源检查。**不做白名单判断**——溯源判红与白名单无关（白名单
 * 外的溯源文件更该红）；argv[0] 的"解析"即 matchProgram 产物 `absPath`（裸
 * 名=登记真身，绝对路径=realpath 产物），同样参与溯源判红——登记真身本身是
 * driver-authored 文件也必须红。
 *
 * 解释器身份判定（裁定，非字符串前缀猜）：取 `ctx.program.absPath` 的
 * basename，剥 `.exe/.bat/.cmd` 后缀、整串小写，查精确清单（下方
 * INTERPRETER_INLINE）——按**真身文件名**判定，不是 argv[0] 字符串、不是
 * 登记名（登记名与真身分歧时以真身为准）。旗标匹配=argv[1..] 元素**整
 * token 精确相等**（不拆组合旗标、不做前缀/子串猜测），扫描全部位置——
 * `python -u -c`、`cmd /d /c` 的旗标不在首位；代价是旗标成为子命令参数时
 * 误红（如 `python script.py -c`），落在宁可误红不可漏红的方向。
 *
 * 已知 v0 留白（有意不外推，扩清单须改此处并逐个补测试钉）：`pwsh
 * -EncodedCommand`、`cmd /k`、POSIX 组合旗标（`bash -lc`）、`node
 * --eval=<code>` 均为真实内联入口，未在 plan 钉死的精确清单内——留待 review
 * 裁定后扩。
 */

/** 判级产物：tier 字符串，或 exec 硬拒（deny 码域钉死为协议七码中的两位——
 * Extract 保证协议侧码漂移即编译错）。本函数永不产出 PATH_DENIED（fs 路径
 * 判定归 executor 的 path-guard 步），保留于码域只为与 executor 的 deny
 * 透传形状对齐（plan Produces verbatim）。 */
export type ConfirmTierDenyCode = Extract<
  Mecha.MechaErrorCode,
  'PATH_DENIED' | 'PROGRAM_DENIED'
>;

export type ConfirmTier = 'T0' | 'T1' | 'T2' | { deny: ConfirmTierDenyCode };

/** 协议单一事实源取码；返回类型已把字面量钉死——协议七码若变动此位，此处
 * 编译期即报错（防常量漂移，风格随 path-guard/program-guard）。 */
const PROGRAM_DENIED: 'PROGRAM_DENIED' = Mecha.MECHA_ERROR_CODES[1];

const WIN32 = process.platform === 'win32';

/** win32 盘符相对形态（`C:foo`——盘符后有字符但无分隔符）。node 的
 * path.resolve 对这类形态只按本进程 cwd 归基（非当前盘一律猜盘根），而 exec
 * 子进程按内核 per-drive cwd 表解析——两侧解析基座可能分歧，溯源判红的解析
 * 结果因此不可靠（歧义不可判定）。宁可误红不可漏红：一律 T2——消费者极少
 * 以盘符相对形态传参，误红代价是一次确认；漏红代价是红卡逃逸。仅 win32
 * 生效（posix 上该形态只是普通文件名，无解析歧义）。 */
const DRIVE_RELATIVE = /^[a-zA-Z]:[^\\/]/;

/** computeTier 的注入上下文：program 为 executor 预先求好的 matchProgram
 * 产物（本函数不做程序表复查）；provenance 为溯源判红谓词
 * （ProvenanceStore.isDriverAuthored 的注入形态——测试以注入模拟跨会话
 * 马甲）。入参为真实化形态路径；零 fs 访问契约随 ProvenanceStore。 */
export interface ComputeTierContext {
  program: ProgramGuardResult;
  provenance: (realPath: string) => boolean;
}

/**
 * 解释器内联旗标精确清单（plan 钉死，测试逐个钉）：键=程序真身 basename
 * （去 .exe/.bat/.cmd、小写）。caseInsensitive 仅限 Windows 原生解释器
 * （powershell/cmd——旗标解析大小写不敏感，`-command`/`/CE` 都是真实内联
 * 入口，精确大小写会漏红）；POSIX 解释器旗标大小写敏感（`bash -C` 是
 * noclobber 而非内联，折叠反而语义错误）。
 */
const INTERPRETER_INLINE: Record<
  string,
  { flags: string[]; caseInsensitive: boolean }
> = {
  python: { flags: ['-c'], caseInsensitive: false },
  python3: { flags: ['-c'], caseInsensitive: false },
  node: { flags: ['-e', '--eval'], caseInsensitive: false },
  powershell: { flags: ['-command'], caseInsensitive: true },
  pwsh: { flags: ['-command'], caseInsensitive: true },
  bash: { flags: ['-c'], caseInsensitive: false },
  sh: { flags: ['-c'], caseInsensitive: false },
  zsh: { flags: ['-c'], caseInsensitive: false },
  cmd: { flags: ['/c', '/ce'], caseInsensitive: true },
};

/** 程序真身 → 解释器身份条目：basename 剥 `.exe/.bat/.cmd`（大小写不敏感）、
 * 整串小写后查表。非解释器返回 undefined。零 fs 访问。 */
function interpreterEntry(
  absPath: string,
): { flags: string[]; caseInsensitive: boolean } | undefined {
  const base = path
    .basename(absPath)
    .replace(/\.(exe|bat|cmd)$/i, '')
    .toLowerCase();
  return INTERPRETER_INLINE[base];
}

/** 解释器内联判定：argv[1..] 任一元素整 token 等于该解释器的内联旗标。 */
function isInterpreterInline(absPath: string, argv: string[]): boolean {
  const entry = interpreterEntry(absPath);
  if (!entry) return false;
  for (let i = 1; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue; // 越界防御（循环条件上不为真）
    const token = entry.caseInsensitive ? raw.toLowerCase() : raw;
    if (entry.flags.includes(token)) return true;
  }
  return false;
}

/** exec 判级（见文件头判级表①-④）。 */
function execTier(
  op: Extract<Mecha.MechaOp, { type: 'exec.run' }>,
  ctx: ComputeTierContext,
): ConfirmTier {
  // ① 程序白名单：argv[0] 未命中表 = 硬拒（优先于一切判级信号）
  if (!ctx.program.ok) {
    return { deny: PROGRAM_DENIED };
  }

  // ② 解释器内联模式 → T2（argv[0] 合法也必须红）
  if (isInterpreterInline(ctx.program.absPath, op.argv)) {
    return 'T2';
  }

  // ③ 溯源判红：argv 任一元素解析为溯源文件 → T2
  //    argv[0]：matchProgram 产物即其真实化形态
  if (ctx.provenance(ctx.program.absPath)) {
    return 'T2';
  }
  //    argv[1..]：R2 裁定——按 exec.cwd resolve 后 realpathAllowingTail 真实
  //    化（存在，或最长存在前缀+尾段）才查溯源；解析不可判定（null）则跳过
  //    该元素。不做白名单判断；相对 cwd 的解析基座问题由 executor 的 cwd
  //    白名单校验兜底拒（op 终被拒，判级结果不生效）。
  for (let i = 1; i < op.argv.length; i++) {
    const arg = op.argv[i];
    if (arg === undefined) continue; // 越界防御（循环条件上不为真）
    // 盘符相对形态：解析基座在 node 与子进程内核间可能分歧 → 不做不可靠的
    // 溯源解析，直接红（fail-safe，见 DRIVE_RELATIVE 注释）
    if (WIN32 && DRIVE_RELATIVE.test(arg)) return 'T2';
    const resolved = realpathAllowingTail(path.resolve(op.cwd, arg));
    if (resolved === null) continue; // 不可判定 → 跳过（R2 裁定）
    if (ctx.provenance(resolved)) return 'T2';
  }

  // ④ 其余 exec = T1
  return 'T1';
}

/**
 * confirm-tier 判级（见文件头判级表与解析口径）。
 */
export function computeTier(op: Mecha.MechaOp, ctx: ComputeTierContext): ConfirmTier {
  switch (op.type) {
    case 'fs.list':
    case 'fs.read':
      return 'T0';
    case 'fs.write':
    case 'fs.mkdir':
    case 'fs.move':
    case 'fs.copy':
    case 'fs.delete':
    case 'file.upload':
      return 'T1';
    case 'exec.run':
      return execTier(op, ctx);
    default: {
      // 穷尽哨兵：九原语全覆盖；穿透至此 = schema 外形状（编码错误），响亮
      // 失败而非静默判级（若新增原语漏改此处，编译期 never 赋值即报错）。
      const exhaustive: never = op;
      throw new Error(
        `computeTier: 未知 op type（schema 外形状）: ${JSON.stringify(
          (exhaustive as Mecha.MechaOp).type,
        )}`,
      );
    }
  }
}
