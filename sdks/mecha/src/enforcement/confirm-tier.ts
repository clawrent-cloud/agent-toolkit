import * as path from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { realpathAllowingTail, realpathCanonical } from './path-guard.js';
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
 * 外的溯源文件更该红）；argv[0] 的解析 = matchProgram 产物 `absPath` 再过
 * `realpathCanonical`（裸名命中返回的是登记路径 verbatim，须归一到与溯源
 * 登记键同一宇宙——review 裁定 Important 4），同样参与溯源判红——登记真身
 * 本身是 driver-authored 文件也必须红；归一失败（表构建与 exec 之间二进制
 * 被删）仅跳过 argv[0] 的溯源检查（程序表已把关、spawn 必败，漏红无实害）。
 *
 * 解释器身份判定（裁定，非字符串前缀猜）：取 `ctx.program.absPath` 的
 * basename，剥 `.exe/.bat/.cmd` 后缀 → 剥尾部版本后缀（`python3.11` →
 * `python3`）→ 整串小写 → 别名归一（`py`/`pythonw` → python、
 * `pwsh-preview` → pwsh——review 裁定 Important 3 的固定顺序），查精确清单
 * （下方 INTERPRETER_INLINE）——按**真身文件名**判定，不是 argv[0] 字符串、
 * 不是登记名（登记名与真身分歧时以真身为准）。旗标匹配扫描 argv[1..] 全部
 * 位置（`python -u -c`、`cmd /d /c` 的旗标不在首位）：
 *  - 整 token 精确相等，或 `flag + '='` equals 形（`--eval=<code>`、
 *    `-Command=<code>`——review 裁定扩充）；
 *  - attached-value 前缀族（review 裁定 Critical 1/2）：`cmd` 的 `/c`/`/k`/
 *    `/r`（`/R` 为 /C 未记载别名，re-review 收口裁定）与 `python`/`python3`
 *    的 `-c`——shell 粘连的 `/cdir`、`-cprint(1)` 以单 argv 元素抵达，精确
 *    匹配会漏红；前缀字母取各 CLI 独占段（cmd 无其他 c/k/r 首开关、CPython
 *    无其他 c 首短选项），零误红代价；node 的短旗标不吃粘连值（`-e<code>`
 *    报 bad option，实测）故不加；
 *  - powershell/pwsh 另认 `-enc…` 无歧义缩写族（EncodedCommand——`-enc` 起
 *    的任何前缀都无歧义指向它，ExecutionPolicy 是 `-ex…` 无碰撞；review
 *    裁定扩充，经典 LOLBin 内联入口）；
 *  - bash/sh/zsh 另认单杠组合短旗标簇含小写 `c`（`-lc`/`-cl`/`-ic`…——簇内
 *    有 c 即消费下一参数为命令串；大小写敏感，`-C` 是 noclobber 不是内联；
 *    review 裁定扩充）；
 *  - node 另认 `-p`（及文档化长形 `--print`）求值打印旗标（实测
 *    `node -p '1+1'` → 2、`node --print '1+1'` → 2——本身就是内联入口，
 *    review 第二轮/收口裁定）与单杠簇含 `e`（`-pe` = -p + -e，实测可执行；
 *    大小写敏感；仅 node 启用 e 簇、仅 bash/sh/zsh 启用 c 簇——cmd/powershell
 *    的多字符旗标语义不同，不做逐字解析）；
 *  - python/python3 另认 `-m`（final review C1 裁定）：`python -m mod` 以
 *    cwd 为 sys.path[0] 解析模块——cwd 白名单内的植入 `mod.py` 即被执行，
 *    而 `modulename` 解析为不存在的路径、溯源零命中 → 原判 T1 漏红；`-m`
 *    整体判内联（宁误红接受 `python -m pip`）；
 *  除此不拆组合、不做前缀/子串猜测；代价是旗标成为子命令参数时误红（如
 *  `python script.py -c`），落在宁可误红不可漏红的方向。
 *
 * 旗标 token 内嵌路径（final review C1 裁定 (b)/(c)，宁误红）：解释器清单
 * 之外的旗标也能把路径语义藏进单元素 token（`--require=./evil.js`——路径
 * 嵌在旗标里，按文件名解析必落空 → 溯源零命中 → T1 漏红）。两道收口：
 *  - (c) 形态门：`-` 打头的 token 含路径分隔符（`/` 或 `\`）或（win32）盘符
 *    → T2 一律红，与实存/溯源无关——它是加载指令（`--require`、
 *    `--experimental-loader`）而非普通实参。`/` 打头的 token 仅 win32 参与
 *    （cmd/powershell 旗标语义，`/p:C:\x` 形态）；posix 上 `/` 打头是绝对
 *    路径形态——R2 溯源解析的主通道与 T1 基线的载体，不按旗标判（否则
 *    「路径形态 exec T1」的既有钉死语义全灭）；
 *  - (b) 值段溯源：argv 元素含 `=` 时，取**首个** `=` 之后的值段，与裸实参
 *    同口径（exec.cwd resolve → realpathAllowingTail → 查溯源）——值段命中
 *    溯源照红；值段解析不可判定跳过（同 R2）。token 本身无分隔符/盘符时
 *    （`--config=evil.yaml`）这是唯一防线；(c) 已红的 token 值段不再到达
 *    （先判 (c)）。
 * - 环境注入通道（re-review NB-2 / ruling R28，红卡而非剥离）：op.env 命中
 *   危险键（NODE_OPTIONS/PYTHONSTARTUP/LD_PRELOAD 等——启动时代码加载面，
 *   见 EXEC_ENV_DENYLIST）→ T2；确认卡摘要点名命中键（executor 消费
 *   denylistedExecEnvKeys）。win32 键名大小写不敏感，posix 精确匹配。
 *   与内联/溯源为互相独立的判红信号（先到先红）；remember 记忆集只对 T1
 *   生效，env 红卡天然不被越过。
 *
 * v0 清单外明确不补（非内联入口，或已被其他机制覆盖）：`pwsh -File
 * <script>` 是文件执行——脚本路径作为 argv 元素已由溯源判红覆盖；
 * `python -m` 原判「传递性执行接受」已被 final review C1 推翻（-m 升内联，
 * 见上）；`-e`/`-en` 级 pwsh 缩写有歧义（PowerShell 参数绑定直接报错，
 * 不构成执行入口）。
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

/** win32 盘符相对形态（`C:foo`，以及裸盘符 `C:`——两者都按内核 per-drive
 * cwd 表解析）。node 的 path.resolve 对这类形态只按本进程 cwd 归基（非当前
 * 盘一律猜盘根），而 exec 子进程按内核 per-drive cwd 表解析——两侧解析基座
 * 可能分歧，溯源判红的解析结果因此不可靠（歧义不可判定）。宁可误红不可漏
 * 红：一律 T2——消费者极少以盘符相对形态传参，误红代价是一次确认；漏红代
 * 价是红卡逃逸。仅 win32 生效（posix 上该形态只是普通文件名，无解析歧义）。 */
const DRIVE_RELATIVE = /^[a-zA-Z]:(?:[^\\/]|$)/;

/** computeTier 的注入上下文：program 为 executor 预先求好的 matchProgram
 * 产物（本函数不做程序表复查）；provenance 为溯源判红谓词
 * （ProvenanceStore.isDriverAuthored 的注入形态——测试以注入模拟跨会话
 * 马甲）。入参为真实化形态路径；零 fs 访问契约随 ProvenanceStore。 */
export interface ComputeTierContext {
  program: ProgramGuardResult;
  provenance: (realPath: string) => boolean;
}

/**
 * 解释器内联旗标精确清单（plan 钉死 + review 裁定扩充，逐项测试钉）：键=
 * 程序真身 basename（去 .exe/.bat/.cmd → 剥尾部版本后缀 → 小写 → 别名归一，
 * 见 interpreterEntry）。caseInsensitive 仅限 Windows 原生解释器
 * （powershell/cmd——旗标解析大小写不敏感，`-command`/`/CE` 都是真实内联
 * 入口，精确大小写会漏红；PowerShell 参数绑定在所有宿主平台都折叠大小写）；
 * POSIX 解释器旗标大小写敏感（`bash -C` 是 noclobber 而非内联，折叠反而
 * 语义错误）。
 */
interface InterpreterInlineSpec {
  /** 精确旗标；`flag + '='` equals 形（`--eval=<code>`、`-Command=<code>`）
   * 一并命中（review 裁定 4）。 */
  flags: string[];
  /** 无歧义前缀族：attached-value 形态（`cmd /c<command>`、`python -c<code>`
   * ——shell 粘连后作为单 argv 元素抵达）与无歧义缩写族（powershell `-enc…`
   * 只能是 EncodedCommand）。前缀字母取各解释器 CLI 的独占段——cmd 无其他
   * c/k 首字母开关、CPython 无其他 c 首字母短选项，零误红代价（review 裁定
   * Critical 1/2）。 */
  prefixes?: string[];
  /** win32 原生旗标解析大小写不敏感（powershell/cmd——PowerShell 参数绑定
   * 在所有宿主平台折叠大小写；POSIX 解释器一律敏感）。 */
  caseInsensitive: boolean;
  /** POSIX 组合短旗标簇（review 裁定 3/第二轮）：单杠多字符簇含该字符即视
   * 为内联（bash/sh/zsh → `c`：`-lc`/`-cl`/`-ic`…——簇内有 c 即消费下一参数
   * 为命令串；node → `e`：`-pe` = -p 求值打印 + -e 求值，实测真实内联入口）。
   * 大小写敏感；仅注明的解释器启用——cmd/powershell 多字符旗标语义不同，
   * 不做逐字解析。 */
  shortFlagClusterChar?: 'c' | 'e';
}

const INTERPRETER_INLINE: Record<string, InterpreterInlineSpec> = {
  // -m 升内联（final review C1）：`python -m mod` 经 sys.path[0]=cwd 解析
  // 模块文件，白名单植入体借此绕过溯源判红——宁误红接受 `python -m pip`。
  // -m 同时进前缀族（re-review NB-1）：粘连形 `-m<module>`（`python
  // -mjson.tool` 惯用法）以单元素抵达，精确匹配只认整 token 会漏红；CPython
  // 无其他 m 首短选项，零误红代价（与 -c 前缀同一选段逻辑）。py/pythonw 等
  // 别名指向 python 键，自动继承。
  python: { flags: ['-c', '-m'], prefixes: ['-c', '-m'], caseInsensitive: false },
  python3: { flags: ['-c', '-m'], prefixes: ['-c', '-m'], caseInsensitive: false },
  // -p 实测即求值打印（node -p '1+1' → 2）——本身就是内联旗标（review 第二轮裁定）；
  // --print 为其文档化长形（实测 node --print '1+1' → 2，re-review 收口裁定）
  node: {
    flags: ['-e', '--eval', '--expression', '-p', '--print'],
    caseInsensitive: false,
    shortFlagClusterChar: 'e',
  },
  powershell: {
    flags: ['-command', '-encodedcommand'],
    prefixes: ['-enc'],
    caseInsensitive: true,
  },
  pwsh: {
    flags: ['-command', '-encodedcommand'],
    prefixes: ['-enc'],
    caseInsensitive: true,
  },
  bash: { flags: ['-c'], caseInsensitive: false, shortFlagClusterChar: 'c' },
  sh: { flags: ['-c'], caseInsensitive: false, shortFlagClusterChar: 'c' },
  zsh: { flags: ['-c'], caseInsensitive: false, shortFlagClusterChar: 'c' },
  // /ce 旧缩写被 /c 前缀吸收（review 裁定 Critical 1 折叠 Minor 7）；/R 为
  // /C 未记载别名（实测 cmd /r echo 可执行，re-review 收口裁定）
  cmd: {
    flags: ['/c', '/k', '/r'],
    prefixes: ['/c', '/k', '/r'],
    caseInsensitive: true,
  },
};

/** 真身名 → 解释器键别名（review 裁定 Important 3）：高频真实世界形态——
 * Windows 官方启动器 `py` 与窗口版 `pythonw` 归 python 族；预览通道
 * `pwsh-preview` 归 pwsh。（python/python3 本就是同规格的独立键。） */
const INTERPRETER_ALIASES: Record<string, string> = {
  py: 'python',
  pythonw: 'python',
  'pwsh-preview': 'pwsh',
};

/** 真身名尾部版本后缀（`python3.11`、`python3.11.9`——Ubuntu 上 realpath 化
 * symlink 的高频形态），剥到 `python3`。要求点号打头故 `python3` 本身不动。 */
const VERSION_SUFFIX = /\.\d+(\.\d+)*$/;

/** 程序真身 → 解释器身份条目：basename 剥 `.exe/.bat/.cmd`（大小写不敏感）
 * → 剥尾部版本后缀 → 整串小写 → 别名归一（review 裁定 Important 3 的固定
 * 顺序）后查表。非解释器返回 undefined。零 fs 访问。 */
function interpreterEntry(absPath: string): InterpreterInlineSpec | undefined {
  const base = path
    .basename(absPath)
    .replace(/\.(exe|bat|cmd)$/i, '')
    .replace(VERSION_SUFFIX, '')
    .toLowerCase();
  return INTERPRETER_INLINE[INTERPRETER_ALIASES[base] ?? base];
}

/** 组合短旗标簇正则（单杠、次字符非杠、簇内含目标字符；大小写敏感——
 * POSIX/node 旗标解析敏感，`-C` 是 noclobber、`-E` 非 eval）。 */
const CLUSTER_RE: Record<'c' | 'e', RegExp> = {
  c: /^-[^-]*c/,
  e: /^-[^-]*e/,
};

/** 盘符提示（final review C1 (c)）：token 内任何「字母+冒号」段（`C:evil`、
 * `--require=C:x`）。win32 专属语义——posix 上该形态只是普通文件名（与
 * DRIVE_RELATIVE 同一口径），不参与判红。 */
const DRIVE_HINT = /[a-zA-Z]:/;

/**
 * exec 环境注入通道的危险键清单（re-review NB-2 / Controller ruling R28，
 * binding）：这些键能让解释器/动态链接器在**启动时**加载任意代码——
 * NODE_OPTIONS（node 启动旗标注入）、PYTHONPATH/PYTHONSTARTUP、BASH_ENV/ENV
 * （POSIX shell 启动文件）、LD_PRELOAD/DYLD_INSERT_LIBRARIES（动态链接劫
 * 持）、PERL5OPT/RUBYOPT/JAVA_TOOL_OPTIONS/SHELLOPTS（各解释器启动面）。
 * 确认卡只展示 argv+cwd，env 值不进卡面——`env:{NODE_OPTIONS:'--require
 * ./evil.js'}` 会在一张无辜的 T1 卡后面执行上传代码。命中任一键 → **T2**
 * （裁定红卡而非剥离：卡面点名键名，披露后由消费者定夺）。win32 键名大小
 * 写不敏感匹配（NTFS 键语义），posix 精确匹配。
 */
const EXEC_ENV_DENYLIST: readonly string[] = [
  'NODE_OPTIONS',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'DYLD_INSERT_LIBRARIES',
  'PERL5OPT',
  'RUBYOPT',
  'JAVA_TOOL_OPTIONS',
  'SHELLOPTS',
];

/**
 * op.env 的危险键命中检测：返回命中的**规范键名**（denylist 侧拼写，供确认
 * 卡披露「环境变量含 <键>」；win32 上驱动的大小写变体同样归一到规范名）。
 * env 缺省/无命中 → 空表。computeTier 的 exec 分支与 executor 的确认摘要
 * 共用同一判定（两处口径绝不允许漂移）。
 */
export function denylistedExecEnvKeys(
  env: Record<string, string> | undefined,
): string[] {
  if (env === undefined) return [];
  const keys = Object.keys(env);
  if (keys.length === 0) return [];
  if (WIN32) {
    const lowered = new Set(keys.map((k) => k.toLowerCase()));
    return EXEC_ENV_DENYLIST.filter((d) => lowered.has(d.toLowerCase()));
  }
  const present = new Set(keys);
  return EXEC_ENV_DENYLIST.filter((d) => present.has(d));
}

/**
 * 旗标 token 内嵌路径判定（final review C1 (c)，宁误红）：`-`/`/` 打头的
 * token 中出现路径分隔符或盘符 → T2 一律红——它是加载指令
 * （`--require=./evil.js`、`--experimental-loader=./x`、win32 的
 * `/p=C:\evil.js`）而非普通实参，路径嵌在 token 内按文件名解析必落空，
 * 溯源通道对此失明。与实存/溯源登记无关（不存在的路径也红——语义面已
 * 越界）。posix 上 `/` 打头的 token 是绝对路径形态（R2 溯源解析的主通道、
 * 路径形态 exec T1 基线的载体），不按旗标判。
 */
function flagTokenEmbedsPath(arg: string): boolean {
  const rest = arg.slice(1); // 剥旗标首字符——`/d` 的引导斜杠不是路径分隔符
  if (arg.startsWith('-')) {
    return /[\\/]/.test(rest) || (WIN32 && DRIVE_HINT.test(arg));
  }
  if (arg.startsWith('/')) {
    return WIN32 && (/[\\/]/.test(rest) || DRIVE_HINT.test(arg));
  }
  return false;
}

/** 解释器内联判定：argv[1..] 任一元素命中该解释器的内联旗标（精确、
 * `flag='` equals 形、无歧义前缀族、组合短旗标簇——见清单注释）。 */
function isInterpreterInline(absPath: string, argv: string[]): boolean {
  const entry = interpreterEntry(absPath);
  if (!entry) return false;
  for (let i = 1; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === undefined) continue; // 越界防御（循环条件上不为真）
    const token = entry.caseInsensitive ? raw.toLowerCase() : raw;
    for (const flag of entry.flags) {
      if (token === flag || token.startsWith(`${flag}=`)) return true;
    }
    if (entry.prefixes?.some((p) => token.startsWith(p))) return true;
    if (
      entry.shortFlagClusterChar !== undefined &&
      CLUSTER_RE[entry.shortFlagClusterChar].test(token)
    ) {
      return true;
    }
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

  // ②′ 环境注入通道（R28）：op.env 命中危险键 → T2——env 值不进确认卡面，
  // 危险键是绕过卡面的启动时代码加载通道；红卡而非剥离（披露后由消费者
  // 定夺）。独立判红信号：与内联/溯源互不排斥，先到先红。
  if (denylistedExecEnvKeys(op.env).length > 0) {
    return 'T2';
  }

  // ② 解释器内联模式 → T2（argv[0] 合法也必须红）
  if (isInterpreterInline(ctx.program.absPath, op.argv)) {
    return 'T2';
  }

  // ③ 溯源判红：argv 任一元素解析为溯源文件 → T2
  //    argv[0]：absPath 先过 realpathCanonical——与 ProvenanceStore 的登记键
  //    同一宇宙（裸名命中返回的是登记路径 verbatim：符号链接段/8.3 短名/
  //    大小写漂移都会让 verbatim 键查不中登记键，review 裁定 Important 4）。
  //    真实化失败（表构建与 exec 之间二进制被删）→ 仅跳过 argv[0] 的溯源
  //    检查：程序表命中已把关，二进制不存在则 spawn 必败、op 终不执行——
  //    跳过不扩大该次执行的实际风险面（漏红无实害；fail 方向分析钉此）。
  let argv0Real: string | null;
  try {
    argv0Real = realpathCanonical(ctx.program.absPath);
  } catch {
    argv0Real = null;
  }
  if (argv0Real !== null && ctx.provenance(argv0Real)) {
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
    // C1(c)：旗标 token 内嵌路径/盘符 → 一律红（加载指令面，与溯源无关）
    if (flagTokenEmbedsPath(arg)) return 'T2';
    const resolved = realpathAllowingTail(path.resolve(op.cwd, arg));
    if (resolved === null) continue; // 不可判定 → 跳过（R2 裁定）
    if (ctx.provenance(resolved)) return 'T2';
    // C1(b)：`=` 值段按裸实参同口径溯源解析（`--require=./evil.js`、
    // `--config=evil.yaml` 的值段宇宙）——token 无分隔符/盘符时的唯一防线
    const eq = arg.indexOf('=');
    if (eq >= 0) {
      const value = arg.slice(eq + 1);
      if (value !== '') {
        const resolvedValue = realpathAllowingTail(path.resolve(op.cwd, value));
        if (resolvedValue !== null && ctx.provenance(resolvedValue)) return 'T2';
      }
    }
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
