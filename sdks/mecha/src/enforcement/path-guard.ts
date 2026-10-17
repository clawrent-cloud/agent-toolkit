import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mecha } from '@clawrent/protocol';

/**
 * 文件系统硬边界（spec 生死线）：机甲驱动请求的每个 fs op 路径都必须先过
 * `resolveWithinWhitelist`。解析三步——
 *
 *  1. `path.resolve(cwd, inputPath)` 归一为绝对路径（`..` 在此消除）；
 *  2. realpath 真实化：win32 用 `fs.realpathSync.native`（GetFinalPathNameBy
 *     Handle——返回盘上真实大小写并展开 8.3 短名；普通 realpathSync 保留输入
 *     大小写，不构成规范化），posix 用 `fs.realpathSync`（大小写敏感 FS，输入
 *     即盘上大小写）。目标不存在（且仅 ENOENT）时逐段向上找最长存在父目录取
 *     realpath，再把剩余段拼回；任何其他 errno（EACCES/EPERM/EIO/ELOOP…）
 *     ＝不可判定，硬拒——绝不把权限/IO 故障误当"不存在"继续回退（存在段中的
 *     符号链接被真实解析——白名单内符号链接指向界外，落点在界外，拒）；
 *  3. 真实路径与各白名单目录的 realpath 做**段边界**前缀匹配。两侧都是
 *     realpath 规范化产物（盘上真实大小写），比较**大小写敏感**、逐字符——
 *     win32 仅折叠盘符；JS 层大小写折叠会制造 NTFS $UpCase 不认同的同形
 *     影子（ß/ẞ 类），一律不做。命中任一即放行并返回 `real`——**驱动必须用
 *     返回的 `real` 执行实际 op**，检查对象即操作对象。
 *
 * 参数契约（Task 10 依赖）：`cwd` 与每个白名单条目都必须是绝对路径，违反即
 * 抛 TypeError（配置错误 fail-closed）；`inputPath` 允许相对（按 cwd 解析）。
 *
 * fail-closed：白名单目录不存在/不可解析则该条目不构成授权；不可判定错误、
 * 无法真实化的路径（设备命名空间等）不命中任何真实前缀，一律拒。
 */

/** 白名单内放行（带真实化后的绝对路径）或硬拒（协议七码之一 PATH_DENIED）。 */
export type PathGuardResult =
  | { ok: true; real: string }
  | { ok: false; code: 'PATH_DENIED' };

/** 协议单一事实源取码；返回类型已把 code 钉死为 'PATH_DENIED'——协议七码若
 * 变动此位，此处编译期即报错（防常量漂移）。 */
const PATH_DENIED: 'PATH_DENIED' = Mecha.MECHA_ERROR_CODES[0];

const WIN32 = process.platform === 'win32';

/** 统一比较形态：分隔符归一（win32 把 `\` 视作分隔符；posix 反斜杠是合法
 * 文件名字符，不动）+ win32 仅折叠盘符。其余逐字符大小写敏感。导出供
 * program-guard 共用同一规范形（两个 guard 的比较口径绝不允许漂移）。 */
export function comparableForm(p: string): string {
  let s = WIN32 ? p.replace(/[\\/]+/g, '/') : p.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1); // 去尾分隔符（POSIX 根除外）
  if (WIN32) s = s.replace(/^[a-zA-Z]:/, (d) => d.toLowerCase()); // 仅盘符
  return s;
}

/** 段边界前缀判定：child 等于 ancestor，或位于其下。禁字符串假命中
 * （如 /a/b 以 /a/bc 为"前缀"）。 */
function isUnderOrEqual(child: string, ancestor: string): boolean {
  const c = comparableForm(child);
  const a = comparableForm(ancestor);
  if (c === a) return true;
  if (a === '/') return c.startsWith('/'); // POSIX 根特例
  return c.startsWith(a + '/');
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** 真实化（两侧比较的规范形来源）：win32 用 native——盘上真实大小写 + 展开
 * 8.3 短名（普通 realpathSync 保留输入大小写，实证不构成规范化）；posix 大小
 * 写敏感 FS 上 realpathSync 即规范形（native 在 mac 大小写不敏感能力上反而
 * 会把变体放行，违背 posix 分支的 fail-closed 断言）。导出供 program-guard
 * 共用同一规范形（两个 guard 的比较口径绝不允许漂移）。 */
export function realpathCanonical(p: string): string {
  return WIN32 ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

/**
 * realpath 允许 ENOENT 尾段：目标可真实化则直接返回；否则逐段向上找最长
 * 存在父目录取 realpath、剩余段原样拼回。存在段中的符号链接被真实解析（越界
 * symlink 被拒的机制所在）。**仅 ENOENT 继续回退**：其他 errno 返回 null，
 * 由调用方硬拒。连根都 ENOENT（理论不可达）时退回裸根——它不构成真实前缀
 * 命中，最终按拒处理（fail-closed）。
 *
 * 导出供 confirm-tier（R2 裁定）共用同一 realpath 语义：exec argv 非首元素
 * 按 exec.cwd resolve 后经此真实化（存在，或最长存在前缀+尾段）才查溯源，
 * 解析不可判定（null）则跳过该元素。confirm-tier 侧**不做白名单判断**——
 * 溯源判红与白名单无关，两个消费场景互不耦合，仅共享真实化口径。
 */
export function realpathAllowingTail(abs: string): string | null {
  try {
    return realpathCanonical(abs);
  } catch (err) {
    if (!isEnoent(err)) return null;
  }
  const tail: string[] = [path.basename(abs)]; // 首层父目录成功时也须拼回末段
  let current = path.dirname(abs);
  for (;;) {
    try {
      const realParent = realpathCanonical(current);
      return path.join(realParent, ...tail);
    } catch (err) {
      if (!isEnoent(err)) return null;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * 白名单硬边界判定（见文件头注释）。`cwd` 与白名单条目必须绝对（否则抛
 * TypeError）；白名单条目真实化后参与比较，不存在/不可真实化的条目不构成
 * 授权（fail-closed）。
 */
export function resolveWithinWhitelist(
  inputPath: string,
  cwd: string,
  dirs: string[],
): PathGuardResult {
  if (!path.isAbsolute(cwd)) {
    throw new TypeError(
      `resolveWithinWhitelist: cwd 必须为绝对路径，收到 ${JSON.stringify(cwd)}`,
    );
  }
  for (const dir of dirs) {
    if (!path.isAbsolute(dir)) {
      throw new TypeError(
        `resolveWithinWhitelist: 白名单条目必须为绝对路径，收到 ${JSON.stringify(dir)}`,
      );
    }
  }

  const real = realpathAllowingTail(path.resolve(cwd, inputPath));
  if (real === null) {
    return { ok: false, code: PATH_DENIED }; // 不可判定（非 ENOENT）→ 硬拒
  }
  for (const dir of dirs) {
    let dirReal: string;
    try {
      dirReal = realpathCanonical(path.resolve(dir));
    } catch {
      continue; // 白名单目录不存在/不可真实化——不构成授权（fail-closed）
    }
    if (isUnderOrEqual(real, dirReal)) {
      return { ok: true, real };
    }
  }
  return { ok: false, code: PATH_DENIED };
}
