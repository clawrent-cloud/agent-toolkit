import * as path from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { comparableForm, realpathCanonical } from './path-guard.js';

/**
 * 程序白名单硬边界（spec 生死线 A10）：exec 的 argv[0] 只有两类合法来源——
 *
 *  1. 裸名（不含任何路径分隔符）：**只查 name 表**，精确匹配（大小写敏感），
 *     命中即放行并原样返回登记真身 `absPath`。**全程零文件系统访问**——不查
 *     PATH、不查 cwd、不验存在性：驱动在白名单/PATH/cwd 植入假同名程序
 *     （python.bat 类）后，裸名依然只认登记表（Review Focus #2）。登记路径
 *     不存在由 exec 层 spawn 失败兜底（表内容本就在驱动手中的
 *     CapabilityManifest 里，无信息泄露面）。名字表精确匹配——大小写变体不
 *     命中即拒（fail-closed，平台要支持变体就登记变体）；同名词目取表序
 *     第一条。
 *  2. 绝对路径：argv[0] 真实化（win32 用 `fs.realpathSync.native`——盘上真实
 *     大小写并展开 8.3 短名，普通 realpathSync 保留输入大小写不构成规范化；
 *     posix 用 `fs.realpathSync`）后与各条目 `absPath` 的真实化形态做可比较
 *     形**精确相等**比较（可比较形随 T6：分隔符归一 + win32 仅折叠盘符，名称
 *     段不做 JS 大小写折叠——同形异码兄弟不得制造影子加持）。win32 的"大小
 *     写不敏感"由此达成：同一文件的任何输入大小写都真实化为同一盘上形态。
 *     任何 realpath 失败（ENOENT=程序不存在 / EACCES、EIO 等不可判定）一律
 *     拒——程序必须真实存在且可真实化才可能被授权执行（符号链接/改指向在
 *     真实化落点处被识别：落点不在表即拒）。命中返回真实化产物——检查对象
 *     即操作对象。
 *
 *  其余输入按路径分支处理并拒：相对路径与 `C:foo` 盘符相对形式的解析基座是
 *  攻击者可控 cwd，**永不解析、直接拒**；空串不是裸名。
 *
 * **永不文件系统搜索**：本模块不存在任何"从名字找文件"的逻辑——裸名只查
 * 内存表；路径分支只真实化调用方给定的路径（解析，不是搜索）。
 *
 * 参数契约（配置错误 fail-closed，风格随 T6）：每个条目 `absPath` 必须绝对，
 * 违反即抛 TypeError（upfront 全量校验，与输入无关，保证契约确定性）。
 */

/** 程序表命中（带授权执行的真实程序绝对路径）或硬拒（协议七码之一
 * PROGRAM_DENIED）。 */
export type ProgramGuardResult =
  | { ok: true; absPath: string }
  | { ok: false; code: 'PROGRAM_DENIED' };

/** 协议单一事实源取码；返回类型已把 code 钉死为 'PROGRAM_DENIED'——协议七码
 * 若变动此位，此处编译期即报错（防常量漂移）。 */
const PROGRAM_DENIED: 'PROGRAM_DENIED' = Mecha.MECHA_ERROR_CODES[1];

const WIN32 = process.platform === 'win32';

/** 裸名判定：不含路径分隔符（posix 只认 `/`；win32 另认 `\`）且非盘符相对
 * 形式（`C:foo` 是盘符相对路径，不是名字）。空串不是裸名。 */
function isBareName(argv0: string): boolean {
  if (argv0 === '') return false;
  if (argv0.includes('/') || (WIN32 && argv0.includes('\\'))) return false;
  if (WIN32 && /^[a-zA-Z]:/.test(argv0)) return false;
  return true;
}

/**
 * 程序白名单硬边界判定（见文件头注释）。
 */
export function matchProgram(
  argv0: string,
  programs: Mecha.MechaProgramEntry[],
): ProgramGuardResult {
  // 参数契约：条目 absPath 必须绝对（配置错误 fail-closed，upfront 全量校验）
  for (const entry of programs) {
    if (!path.isAbsolute(entry.absPath)) {
      throw new TypeError(
        `matchProgram: 程序表条目 absPath 必须为绝对路径，收到 ${JSON.stringify(entry.absPath)}`,
      );
    }
  }

  // 裸名：只查 name 表，零文件系统访问（PATH/cwd/植入体一概无关）
  if (isBareName(argv0)) {
    const hit = programs.find((entry) => entry.name === argv0);
    return hit
      ? { ok: true, absPath: hit.absPath } // 登记真身原样返回
      : { ok: false, code: PROGRAM_DENIED };
  }

  // 路径输入：相对（含盘符相对）永不解析——解析基座是攻击者可控 cwd
  if (!path.isAbsolute(argv0)) {
    return { ok: false, code: PROGRAM_DENIED };
  }

  // 绝对路径：argv[0] 真实化（程序必须真实存在；任何失败=不可判定/不存在=拒）
  let real: string;
  try {
    real = realpathCanonical(argv0);
  } catch {
    return { ok: false, code: PROGRAM_DENIED };
  }
  for (const entry of programs) {
    let entryReal: string;
    try {
      entryReal = realpathCanonical(entry.absPath);
    } catch {
      continue; // 登记真身不存在/不可真实化——不构成授权（fail-closed）
    }
    if (comparableForm(real) === comparableForm(entryReal)) {
      return { ok: true, absPath: real }; // 检查对象即操作对象：返回真实化产物
    }
  }
  return { ok: false, code: PROGRAM_DENIED };
}
