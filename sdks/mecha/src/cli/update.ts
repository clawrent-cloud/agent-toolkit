import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import {
  currentRuntimeEntry,
  installRuntime,
  readPkgMeta,
  resolvePkgDir,
  type RuntimeInstallOpts,
} from '../persist/runtime-install.js';

/**
 * mecha update 手动更新（spec A11 / plan Task 20 / Ruling R22）。
 * **无任何远程自动触发**——本模块没有任何定时器/后台任务/调度，唯一入口是
 * 用户敲 `mecha update`（或编程调用 runUpdate），一切网络动作都由这一次
 * 调用同步发起。流程：
 *
 *  1. GET registry latest 元数据（`MECHA_REGISTRY_LATEST_URL`，fetch 可注入）
 *     → `{ version, dist.tarball }`（zod 校验形状）；
 *  2. 与本地版本比较：**已装 runtime 的 current 指针**（T19 布局；经
 *     currentRuntimeEntry + 读装内 minimal package.json 的 version）优先，
 *     未装 runtime 才回退**运行中包**的 package.json（resolvePkgDir）。非
 *     更新（同版或 registry 更旧——只前进不回退）→ no-op 返回
 *     `{from, to: from, updated: false}`；
 *  3. 更新可用 → 下载 tarball（必须 HTTPS）→ 写临时 .tgz（os.tmpdir() 下
 *     mkdtemp staging）→ 解包到 staging → 校验 → installRuntime 拷入
 *     `<runtime>/v<newVersion>/` 并切 `current`，提示重启守护进程。
 *
 * 解包（R22，**零新增第三方依赖**）：tar 提取不引原生依赖，用 node:zlib
 * gunzip + 本文件内的**最小 tar reader**——只解析 512 字节头（name/prefix/
 * size/typeflag），只抽取 `package/dist/*` 与 `package/package.json` 成员，
 * GNU longname（'L'）认名，PAX（'x'/'g'）等其余类型只跳数据块。**不校验
 * tar 头校验和**：完整性边界是 HTTPS + registry 签名（spec 裁定），本地只
 * 做结构校验——staging 必须含 `package/dist/cli/index.js` +
 * `package/package.json`，且包内 name/version 与 registry 元数据一致，否则
 * 抛「包结构无效」。
 *
 * 失败纪律：**绝不留下半切状态**——`current` 指针只在 staging 校验通过后由
 * installRuntime 切换；此前任何一步失败，staging 整目录 finally 清理，已装
 * runtime 一个字节都不动。
 */

/** registry latest 元数据端点（fetch 注入的缺省目标；plan 接口 verbatim）。 */
export const MECHA_REGISTRY_LATEST_URL = 'https://registry.npmjs.org/@clawrent/mecha/latest';

/** 被更新的包名（tarball 内 package.json 的 name 校验口径）。 */
const PKG_NAME = '@clawrent/mecha';

/** runUpdate 选项：fetchImpl 注入（测试 mock）；homeOverride 承 R17 test-only
 * 落点覆盖（runtime 全部派生其下，测试绝不触碰 `~/.clawrent/mecha`）。 */
export interface UpdateOpts extends RuntimeInstallOpts {
  fetchImpl?: typeof fetch;
}

/** 更新结果（plan 接口 verbatim）。 */
export interface UpdateResult {
  from: string;
  to: string;
  updated: boolean;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── registry 元数据 ──────────────────────────────────────────────────────────

/** latest 响应形状（tarball 必须 HTTPS——下载通道即信任边界）。 */
const RegistryMetaSchema = z.object({
  version: z.string().min(1),
  dist: z.object({ tarball: z.string().min(1).startsWith('https://') }),
});

async function fetchRegistryMeta(
  fetchImpl: typeof fetch,
): Promise<{ version: string; tarball: string }> {
  let res: Response;
  try {
    res = await fetchImpl(MECHA_REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
    });
  } catch (err) {
    throw new Error(`mecha update: registry 不可达（${MECHA_REGISTRY_LATEST_URL}）：${errMsg(err)}`, {
      cause: err,
    });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`mecha update: 查询 registry 失败（status ${res.status}）`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new Error(`mecha update: registry 响应非 JSON（status ${res.status}）`, { cause: err });
  }
  const parsed = RegistryMetaSchema.safeParse(body);
  if (!parsed.success) {
    const at = parsed.error.issues[0]?.path.map(String).join('.') ?? '(root)';
    throw new Error(`mecha update: registry 响应形状非法（${at}）`);
  }
  return { version: parsed.data.version, tarball: parsed.data.dist.tarball };
}

async function downloadTarball(url: string, fetchImpl: typeof fetch): Promise<Buffer> {
  // 双保险：zod schema 已挡 http:，这里再守一道（下载入口自身即边界）
  if (!url.startsWith('https://')) {
    throw new Error(`mecha update: 更新包地址非 HTTPS，拒绝下载（${url}）`);
  }
  let res: Response;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new Error(`mecha update: 下载更新包失败（${url}）：${errMsg(err)}`, { cause: err });
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`mecha update: 下载更新包失败（status ${res.status}）`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ── 本地版本口径 ─────────────────────────────────────────────────────────────

/** 本地版本：已装 runtime 的 current 指针版本优先（读装内 minimal
 * package.json；装内清单不可读视同未装——坏 runtime 环境下 update 仍可用），
 * 未装 runtime 回退运行中包的 package.json（resolvePkgDir）。 */
function resolveLocalVersion(opts?: RuntimeInstallOpts): string {
  const entry = currentRuntimeEntry(opts);
  if (entry !== null) {
    const pkgDir = dirname(dirname(dirname(entry))); // <runtime>/vX/dist/cli/index.js → <runtime>/vX
    try {
      return readPkgMeta(pkgDir).version;
    } catch {
      // fall through：装内清单损坏 → 按未装口径走运行包版本
    }
  }
  return readPkgMeta(resolvePkgDir()).version;
}

/** 解析 semver（core 三段 + 可选 prerelease）；不可解析响亮抛。 */
function parseVersion(v: string): { core: [number, number, number]; pre: string | null } {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/.exec(v);
  if (m === null) throw new Error(`mecha update: 版本号无法解析（${v}）`);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
}

/** 版本比较：a<b → -1。core 逐段数值比较；平局时稳定版 > 预发布、两个预发布
 * 按标识字典序（近似即可——latest dist-tag 恒为稳定版，此分支近乎死码）。 */
function compareVersions(a: string, b: string): number {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const x = va.core[i]!;
    const y = vb.core[i]!;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (va.pre === null && vb.pre === null) return 0;
  if (va.pre === null) return 1;
  if (vb.pre === null) return -1;
  return va.pre === vb.pre ? 0 : va.pre < vb.pre ? -1 : 1;
}

// ── 最小 tar reader（R22：零新增依赖；见文件头）──────────────────────────────

const TAR_BLOCK = 512;

/** 头内 NUL 结尾字符串。 */
function tarStr(h: Buffer, off: number, len: number): string {
  let end = off;
  const limit = off + len;
  while (end < limit && h[end] !== 0) end++;
  return h.subarray(off, end).toString('utf8');
}

/** 头内八进制 size（124..135，NUL/空格终止；GNU base-256 大文件编码不支
 * 持——本包 dist 全是小文件，用不到；解析失败响亮抛）。 */
function tarSize(h: Buffer): number {
  let s = '';
  for (let i = 124; i < 136; i++) {
    const c = h[i]!;
    if (c === 0 || c === 0x20) break;
    s += String.fromCharCode(c);
  }
  const n = Number.parseInt(s, 8);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`mecha update: 更新包结构损坏（tar size 字段非法「${s}」）`);
  }
  return n;
}

/**
 * 最小 tar 解包：gunzip 后逐 512 字节头前进，只把 `package/dist/*` 与
 * `package/package.json` 成员写进 destDir（剥 `package/` 前缀）；目录成员
 * （typeflag '5'）建目录，GNU longname（'L'）认名，其余类型只跳数据块。
 * 成员路径含 `..`/空段/绝对路径/盘符 → 响亮抛（防穿越，绝不写出 destDir）。
 */
function extractPackageTgz(tgz: Buffer, destDir: string): void {
  let tar: Buffer;
  try {
    tar = gunzipSync(tgz);
  } catch (err) {
    throw new Error(`mecha update: 更新包不可解压（gzip 损坏）：${errMsg(err)}`, { cause: err });
  }
  let offset = 0;
  let longName: string | null = null;
  while (offset + TAR_BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + TAR_BLOCK);
    offset += TAR_BLOCK;
    let isZero = true;
    for (const b of header) {
      if (b !== 0) {
        isZero = false;
        break;
      }
    }
    if (isZero) break; // 归档终止块
    const size = tarSize(header);
    if (offset + size > tar.length) {
      throw new Error('mecha update: 更新包结构损坏（tar 数据被截断）');
    }
    const data = tar.subarray(offset, offset + size);
    offset += Math.ceil(size / TAR_BLOCK) * TAR_BLOCK; // 数据按块对齐
    const typeflag = String.fromCharCode(header[156] ?? 0);
    if (typeflag === 'L') {
      // GNU longname：数据块即**下一个**成员的名字
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag !== '0' && typeflag !== '\0' && typeflag !== '5') continue; // PAX 等：只跳数据
    let name: string;
    if (longName !== null) {
      name = longName;
      longName = null;
    } else {
      name = tarStr(header, 0, 100);
      const prefix = tarStr(header, 345, 155); // ustar prefix
      if (prefix !== '') name = `${prefix}/${name}`;
    }
    const isManifest = name === 'package/package.json';
    const isDist = name === 'package/dist' || name.startsWith('package/dist/');
    if (!isManifest && !isDist) continue;
    const rel = name.slice('package/'.length);
    const segs = rel.split('/');
    if (
      segs.some((s) => s === '' || s === '.' || s === '..') ||
      isAbsolute(rel) ||
      /^[a-zA-Z]:/.test(rel)
    ) {
      throw new Error(`mecha update: 更新包成员路径非法（${name}）`);
    }
    const target = join(destDir, ...segs);
    if (typeflag === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  }
}

// ── staging 校验 ─────────────────────────────────────────────────────────────

/** staging 结构校验：两件必需物在位 + 包内 name/version 与 registry 元数据
 * 一致；任何不满足都抛「包结构无效」（此时指针未切、runtime 未动）。 */
function validateStagedPkg(pkgDir: string, registry: { version: string }): void {
  for (const rel of ['package.json', 'dist/cli/index.js']) {
    if (!fs.existsSync(join(pkgDir, ...rel.split('/')))) {
      throw new Error(`mecha update: 包结构无效（缺 ${rel}）`);
    }
  }
  const pkg = readPkgMeta(pkgDir);
  if (pkg.name !== PKG_NAME || pkg.version !== registry.version) {
    throw new Error(
      `mecha update: 包结构无效（包内 ${pkg.name}@${pkg.version} 与 registry ${PKG_NAME}@${registry.version} 不一致）`,
    );
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

/**
 * 手动检查并更新机甲 runtime（无任何远程自动触发，见文件头）。返回
 * `{ from, to, updated }`；无更新（同版或 registry 更旧）时 `to === from`。
 * 成功更新后必须重启守护进程（消息已提示）。
 */
export async function runUpdate(opts: UpdateOpts = {}): Promise<UpdateResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const local = resolveLocalVersion(opts);
  const meta = await fetchRegistryMeta(fetchImpl);
  if (compareVersions(meta.version, local) <= 0) {
    console.log(`已是最新版本 v${local}`);
    return { from: local, to: local, updated: false };
  }
  const staging = fs.mkdtempSync(join(tmpdir(), 'mecha-update-'));
  try {
    const tgz = await downloadTarball(meta.tarball, fetchImpl);
    fs.writeFileSync(join(staging, 'pkg.tgz'), tgz); // 临时 .tgz 落 os.tmpdir()（plan 口径）
    const extracted = join(staging, 'package');
    extractPackageTgz(tgz, extracted);
    validateStagedPkg(extracted, meta);
    await installRuntime(extracted, { homeOverride: opts.homeOverride });
    console.log(`已更新 v${local} → v${meta.version}，请重启机甲守护进程（mecha daemon 或重新开机）`);
    return { from: local, to: meta.version, updated: true };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
