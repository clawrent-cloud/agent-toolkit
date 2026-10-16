import * as fs from 'node:fs';
import * as path from 'node:path';
import { Mecha } from '@clawrent/protocol';

/**
 * 文件系统硬边界（spec 生死线）：机甲驱动请求的每个 fs op 路径都必须先过
 * `resolveWithinWhitelist`。解析三步——
 *
 *  1. `path.resolve(cwd, inputPath)` 归一为绝对路径（`..` 在此消除）；
 *  2. `fs.realpathSync` 真实化：目标不存在时逐段向上找最长存在父目录取其
 *     realpath，再把剩余段拼回（存在段中的符号链接因此被真实解析——白名单内
 *     符号链接指向界外，落点在界外，拒）；
 *  3. 真实路径与各白名单目录的 realpath 做**段边界**前缀匹配（大小写按平台
 *     规则：win32 不敏感、posix 敏感；分隔符统一）。命中任一即放行并返回
 *     `real`——**驱动必须用返回的 `real` 执行实际 op**，检查对象即操作对象。
 *
 * fail-closed：白名单目录不存在/不可解析则该条目不构成授权；无法真实化的
 * 路径（设备命名空间等）不命中任何真实前缀，一律拒。
 */

/** 白名单内放行（带真实化后的绝对路径）或硬拒（协议七码之一 PATH_DENIED）。 */
export type PathGuardResult =
  | { ok: true; real: string }
  | { ok: false; code: 'PATH_DENIED' };

/** 协议单一事实源取码；返回类型已把 code 钉死为 'PATH_DENIED'——协议七码若
 * 变动此位，此处编译期即报错（防常量漂移）。 */
const PATH_DENIED: 'PATH_DENIED' = Mecha.MECHA_ERROR_CODES[0];

const CASE_INSENSITIVE = process.platform === 'win32';

/** 统一比较形态：分隔符归一（win32 把 `\` 视作分隔符）+ 平台大小写规则。 */
function comparableForm(p: string): string {
  let s = CASE_INSENSITIVE ? p.replace(/[\\/]+/g, '/') : p.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1); // 去尾分隔符（POSIX 根除外）
  return CASE_INSENSITIVE ? s.toLowerCase() : s;
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

/**
 * realpath 允许目标不存在：目标可真实化则直接返回；否则逐段向上找最长存在
 * 父目录取 realpath、剩余段原样拼回。存在段中的符号链接被真实解析（越界
 * symlink 被拒的机制所在）。连根都无法真实化时退回最深已尝试祖先——它与
 * 白名单真实前缀不会命中，最终按拒处理（fail-closed）。
 */
function realpathAllowingTail(abs: string): string {
  try {
    return fs.realpathSync(abs);
  } catch {
    // 目标或中间段不存在——走逐段回退
  }
  const tail: string[] = [path.basename(abs)]; // 首层父目录成功时也须拼回末段
  let current = path.dirname(abs);
  for (;;) {
    try {
      const realParent = fs.realpathSync(current);
      return path.join(realParent, ...tail);
    } catch {
      // 该层也不存在——收进尾段继续向上
    }
    const parent = path.dirname(current);
    if (parent === current) {
      // 已到根（根必然存在）；万一真实化失败则 fail-closed
      return current;
    }
    tail.unshift(path.basename(current));
    current = parent;
  }
}

/**
 * 白名单硬边界判定（见文件头注释）。白名单条目相对 `cwd` 解析（绝对条目
 * 不受影响），并真实化后参与比较。
 */
export function resolveWithinWhitelist(
  inputPath: string,
  cwd: string,
  dirs: string[],
): PathGuardResult {
  const real = realpathAllowingTail(path.resolve(cwd, inputPath));
  for (const dir of dirs) {
    if (dir.length === 0) continue; // 空条目不构成授权
    let dirReal: string;
    try {
      dirReal = fs.realpathSync(path.resolve(cwd, dir));
    } catch {
      continue; // 白名单目录不存在/不可真实化——不构成授权（fail-closed）
    }
    if (isUnderOrEqual(real, dirReal)) {
      return { ok: true, real };
    }
  }
  return { ok: false, code: PATH_DENIED };
}
