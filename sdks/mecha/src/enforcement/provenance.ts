import * as fs from 'node:fs';
import * as path from 'node:path';
import { comparableForm } from './path-guard.js';

/**
 * 溯源持久表（spec A9 / §5.6）：`file.upload` 与 `fs.write` 的目标 realPath +
 * 内容哈希全量持久登记——exec 判红（Task 9）的数据源。判红规则：宁可误红
 * 不可漏红；会话 1 写入的脚本、会话 2 再执行照样 T2 红卡（Review Focus #3），
 * 故存储必须跨会话（跨进程）存活：JSON 文件持久化，**构造时读入、record 时
 * 同步落盘**（构造不落盘——首启无文件即空表，直到首次 record 才建）。
 *
 * 比较口径：复用 path-guard 的 `comparableForm`（分隔符归一 + win32 折叠盘符）
 * ——不另造第二套归一；在此之上，**大小写不敏感 FS 平台（win32 / darwin）整串
 * 小写**，linux 及其他真大小写敏感平台不折叠。win32 折叠是 plan 钉死的裁定
 * （"归一后小写比较 win32"）；darwin 折叠是 review 裁定——macOS 默认 APFS
 * 大小写不敏感（仅保留大小写），posix 分支若保持敏感，登记 `/Users/x/Tool.js`
 * 后以 `tool.js` 执行即漏判（T2 红卡被跳过）。这与 path-guard"不做 JS 层大小
 * 写折叠"的原则是**有意分歧**：白名单前缀比较的两侧都是同会话新鲜 realpath
 * （盘上真实形态，逐字符比较即可），而本表跨会话存活——登记时的盘上形态无法
 * 在查询时用原生 realpath 重放求证（目录改名、8.3 名生成策略都可能漂移），折
 * 叠后才与本平台 FS 默认大小写语义一致；折叠可能制造的误红（同形异码影子）
 * 落在 T2 红卡方向——fail-safe。
 *
 * 构造对存量文件的三态处置（fail-closed 谱系）：
 *  - 文件不存在（ENOENT）→ 空表（首启，正常态）；
 *  - 内容损坏 / 形状不可辨 → 按裁定当作空表重建，**损坏字节原样保留为
 *    `<file>.bak`**（绝不静默吞数据；.bak 保留失败则抛错——保不住证据不如
 *    响亮失败）；
 *  - 其他读取错误（EACCES 等不可判定）→ 抛错——静默当空表会让判红全盲
 *    （全部漏红），比损坏更危险。
 *
 * record 契约：`realPath` 必须为绝对路径（调用方契约——executor 一律传
 * path-guard 真实化产物），违反抛 TypeError（配置错误 fail-closed，风格随
 * T6/T7）；同路径重复登记覆盖（最新 hash 为准）。落盘走 tmp + rename 原子
 * 替换，崩溃不留半截 JSON。表内容不做存在性/类型判定（本类零 fs 判定——
 * 判红只看登记，真实化是调用方的职责），**单写者**由守护进程单实例门保证
 * （spec A8），本类不做并发协调。
 */

interface ProvenanceEntry {
  path: string;
  hash: string;
}

/** 盘上文件形状（`provenancePath()` 布局的持久格式）。 */
interface ProvenanceFile {
  entries: ProvenanceEntry[];
}

/** 大小写不敏感 FS 平台：win32（NTFS 默认）与 darwin（APFS 默认——不敏感但
 * 保留大小写）。linux 及其他 posix 默认真敏感，不折叠。 */
const CASE_INSENSITIVE_FS =
  process.platform === 'win32' || process.platform === 'darwin';

/** 登记键：comparableForm（复用 T6 口径）之上，大小写不敏感 FS 平台整串小写
 * （见文件头裁定）。 */
function storageKey(realPath: string): string {
  const c = comparableForm(realPath);
  return CASE_INSENSITIVE_FS ? c.toLowerCase() : c;
}

function isEntryShape(v: unknown): v is ProvenanceEntry {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as { path?: unknown }).path === 'string' &&
    typeof (v as { hash?: unknown }).hash === 'string'
  );
}

function isStoreShape(v: unknown): v is ProvenanceFile {
  return (
    typeof v === 'object' &&
    v !== null &&
    Array.isArray((v as { entries?: unknown }).entries) &&
    (v as { entries: unknown[] }).entries.every(isEntryShape)
  );
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/**
 * 溯源持久表（见文件头注释）：跨会话登记 driver-authored 路径，供 exec argv
 * 判红（Task 9）与统一披露。
 */
export class ProvenanceStore {
  private readonly file: string;
  private readonly entries = new Map<string, ProvenanceEntry>();

  constructor(file: string) {
    if (!path.isAbsolute(file)) {
      throw new TypeError(
        `ProvenanceStore: file 必须为绝对路径，收到 ${JSON.stringify(file)}`,
      );
    }
    this.file = file;

    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (isEnoent(err)) return; // 首启：空表（构造只读，不落盘）
      // 不可判定（EACCES/EIO…）：抛错——静默空表 = 判红全盲（漏红方向）
      throw new Error(`ProvenanceStore: 溯源表不可读（fail-closed）: ${this.file}`, {
        cause: err,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.salvageUnreadable(raw); // 损坏：空表重建 + 证据 .bak（裁定）
      return;
    }
    if (!isStoreShape(parsed)) {
      this.salvageUnreadable(raw); // 形状不可辨：同损坏处置
      return;
    }
    for (const entry of parsed.entries) {
      this.entries.set(storageKey(entry.path), entry);
    }
  }

  /** 登记 driver-authored 路径 + 内容哈希（同步落盘；同路径覆盖）。
   * 落盘失败不对称：flush 抛错时内存已登记——本会话内判红仍生效（fail-safe
   * 方向），重启即失（盘上没有）；故 record 抛错 ≠ 未登记。 */
  record(realPath: string, hash: string): void {
    if (!path.isAbsolute(realPath)) {
      throw new TypeError(
        `ProvenanceStore.record: realPath 必须为绝对路径，收到 ${JSON.stringify(realPath)}`,
      );
    }
    this.entries.set(storageKey(realPath), { path: realPath, hash });
    this.flush();
  }

  /** 判红查询：登记过（按本平台比较口径）即 driver-authored。零 fs 访问。 */
  isDriverAuthored(realPath: string): boolean {
    return this.entries.has(storageKey(realPath));
  }

  /** 同步落盘：自动建父目录 + tmp + rename 原子替换（崩溃不留半截 JSON）。 */
  private flush(): void {
    const data: ProvenanceFile = { entries: [...this.entries.values()] };
    const tmp = `${this.file}.tmp`;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  /** 损坏/不可辨处置：损坏字节原样保留为 .bak（裁定——绝不静默吞数据），
   * 内存置空表。.bak 写失败则抛错上浮（保不住证据不如响亮失败）。 */
  private salvageUnreadable(raw: string): void {
    fs.writeFileSync(`${this.file}.bak`, raw);
    this.entries.clear();
  }
}
