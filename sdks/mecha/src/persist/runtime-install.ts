import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, mechaHome, runtimeDir } from '../constants.js';
import { autostartTarget, type AutostartOpts } from './autostart.js';

/**
 * runtime 自装与卸载（spec A11，plan Task 19）：setup 把**当前包**自拷贝到
 * `~/.clawrent/mecha/runtime/`——版本子目录 `v<version>/`（内含 `dist/` 整
 * 目录 + minimal `package.json`）+ `current` 指针文件（内容 = 当前版本目录
 * 名）。自启单元指向的是**这份拷贝**的入口 js，与 npx 缓存 / 全局 npm 安装
 * 彻底解耦：源包装到哪、哪天被清，都不影响已装 runtime 的开机自启。
 *
 * 拷贝口径（Ruling R21）：**自包含 bundle**——tsup 对 CLI 入口 `noExternal`
 * 全量打包（ws/commander/zod/@clawrent/* 全部内联进 dist/cli/index.js），
 * 因此这里只拷 `dist/` + 写 minimal `package.json`（`{name, version,
 * type:'module'}`），runtime 目录**不是** npm install，没有 node_modules。
 * name/version 从源包 package.json 读取（安装物的自我标识；版本目录名与
 * T20 update 的版本管理同口径）。源包缺 dist/cli/index.js（未 build）或缺
 * name/version → 响亮拒绝——半装的 runtime 不是可交付状态。
 *
 * 幂等语义（Ruling R21b）：同版本重装 = 删旧重拷（目录内不留陈旧文件）；
 * 新版本装入新目录、`current` 切换，**旧版本目录保留**（`mecha update`
 * T20 管理其生命周期；v0 不做自动清理）。`ensureRuntimeInstalled` 是 setup
 * 钩子的幂等门：current 指针已指向同版本且入口在位 → 跳过重拷。
 *
 * 卸载（`uninstallAll`）：删自启单元（autostartTarget 同源推导，装哪删哪）
 * + runtime 整树（含全部版本目录与指针）+ config.json；日志目录与溯源表
 * **默认保留**（审计优先——行车记录与红链是安全资产，`keepLogs: false`
 * 才一并删除）。
 */

/** installRuntime / ensureRuntimeInstalled / uninstallAll 的落点覆盖
 * （R17 注入模式，test-only）：homeOverride 覆盖机甲根目录，runtime/
 * config/logs/provenance 全部由此派生；roamingOverride 透传自启推导。 */
export interface RuntimeInstallOpts {
  homeOverride?: string;
}

/** uninstallAll 选项。 */
export interface UninstallOpts extends RuntimeInstallOpts, AutostartOpts {
  /** 日志与溯源保留（缺省 true，审计优先）；false 才删 logs/ 与 provenance.json。 */
  keepLogs?: boolean;
}

/** 卸载结果（各产物是否实际存在并被删除 + 日志是否保留）。 */
export interface UninstallResult {
  autostartRemoved: boolean;
  runtimeRemoved: boolean;
  configRemoved: boolean;
  logsKept: boolean;
}

// ── 布局推导（homeOverride 派生，缺省走 constants 单一事实源）───────────────

/** runtime 根目录：`<homeOverride ?? mechaHome()>/runtime`（缺省 = constants
 * 的 runtimeDir() 单一事实源）。 */
function runtimeRoot(opts?: RuntimeInstallOpts): string {
  return opts?.homeOverride !== undefined ? join(opts.homeOverride, 'runtime') : runtimeDir();
}

/** 版本子目录名：`v<version>`。 */
function versionDirName(version: string): string {
  return `v${version}`;
}

/** 指定版本的 runtime 入口 js 绝对路径：`<runtimeRoot>/v<version>/dist/cli/index.js`。 */
export function runtimeEntryPath(version: string, opts?: RuntimeInstallOpts): string {
  return join(runtimeRoot(opts), versionDirName(version), 'dist', 'cli', 'index.js');
}

// ── 源包元数据 ───────────────────────────────────────────────────────────────

/** 读源包 package.json 的 name/version（缺文件/坏 JSON/缺字段一律响亮抛）。 */
export function readPkgMeta(pkgDir: string): { name: string; version: string } {
  const manifestPath = join(pkgDir, 'package.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  } catch (err) {
    throw new Error(`installRuntime: 源包清单不可读（${manifestPath}）: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`installRuntime: 源包清单形状非法（${manifestPath}）`);
  }
  const rec = parsed as Record<string, unknown>;
  if (typeof rec['name'] !== 'string' || rec['name'] === '') {
    throw new Error(`installRuntime: 源包清单缺少 name（${manifestPath}）`);
  }
  if (typeof rec['version'] !== 'string' || rec['version'] === '') {
    throw new Error(`installRuntime: 源包清单缺少 version（${manifestPath}）`);
  }
  return { name: rec['name'], version: rec['version'] };
}

/**
 * 从一个模块文件路径向上找包根（最近祖先目录含 package.json）。缺省从本模块
 * 自身定位——bundle 后 `dist/cli/index.js` 向上三级命中包根；从**自装 runtime**
 * 运行时命中 `<runtime>/v<version>`（minimal package.json 在位），npx 缓存
 * 运行时命中缓存里的包根。到底未找到 → 响亮抛。
 */
export function resolvePkgDir(from: string = fileURLToPath(import.meta.url)): string {
  let dir = dirname(from);
  for (;;) {
    if (fs.existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('mecha: 无法定位当前包根目录（向上未找到 package.json）');
}

// ── 安装 ─────────────────────────────────────────────────────────────────────

/**
 * 把当前包自拷贝进 runtime 版本目录并切 `current` 指针，返回入口 js 路径。
 * 幂等：同版本重装 = 删旧重拷；新版本 = 新目录 + 指针切换（旧目录保留）。
 */
export async function installRuntime(pkgDir: string, opts?: RuntimeInstallOpts): Promise<string> {
  const meta = readPkgMeta(pkgDir);
  const srcEntry = join(pkgDir, 'dist', 'cli', 'index.js');
  if (!fs.existsSync(srcEntry)) {
    throw new Error(`installRuntime: 源包缺少 CLI 入口 ${srcEntry}（自包含 bundle 须先 build）`);
  }
  const root = runtimeRoot(opts);
  const destDir = join(root, versionDirName(meta.version));
  const destEntry = join(destDir, 'dist', 'cli', 'index.js');
  // 同版本重装 = 删旧重拷（目录内不留陈旧文件）；目录自建
  fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(join(pkgDir, 'dist'), join(destDir, 'dist'), { recursive: true });
  // minimal package.json（R21）：{name, version, type}——runtime 目录不是 npm install
  fs.writeFileSync(
    join(destDir, 'package.json'),
    `${JSON.stringify({ name: meta.name, version: meta.version, type: 'module' }, null, 2)}\n`,
    'utf8',
  );
  // current 指针：内容 = 版本目录名（读取侧做路径段校验，见 currentRuntimeEntry）
  fs.writeFileSync(join(root, 'current'), `${versionDirName(meta.version)}\n`, 'utf8');
  return destEntry;
}

/**
 * 读 `current` 指针并解析当前 runtime 入口路径。指针缺失/内容非法/指向的
 * 版本目录入口不存在 → null（「未安装」的统一回答；指针内容按纯路径段
 * 校验，分隔符/点段视同污染返回 null，绝不外泄拼接路径）。
 */
export function currentRuntimeEntry(opts?: RuntimeInstallOpts): string | null {
  const root = runtimeRoot(opts);
  let raw: string;
  try {
    raw = fs.readFileSync(join(root, 'current'), 'utf8');
  } catch {
    return null;
  }
  const name = raw.trim();
  if (name === '' || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    return null;
  }
  const entry = join(root, name, 'dist', 'cli', 'index.js');
  try {
    fs.accessSync(entry);
    return entry;
  } catch {
    return null;
  }
}

/**
 * setup 钩子的幂等门：current 指针已指向**同版本**且入口在位 → 原样返回
 * 入口（re-setup 不重拷）；否则（未装/版本更新/入口缺失）安装后返回新入口。
 */
export async function ensureRuntimeInstalled(pkgDir: string, opts?: RuntimeInstallOpts): Promise<string> {
  const { version } = readPkgMeta(pkgDir);
  const expected = runtimeEntryPath(version, opts);
  if (currentRuntimeEntry(opts) === expected) return expected;
  return installRuntime(pkgDir, opts);
}

// ── 卸载 ─────────────────────────────────────────────────────────────────────

/**
 * 卸载本机机甲的持久产物：自启单元（本机平台同源推导）+ runtime 整树（全部
 * 版本目录 + current 指针）+ config.json。日志目录与溯源表默认保留（审计
 * 优先——行车记录与红链是安全资产）；`keepLogs: false` 才一并删除。重复
 * 执行安全（不存在的产物记 false，不抛）。
 */
export async function uninstallAll(opts?: UninstallOpts): Promise<UninstallResult> {
  const keepLogs = opts?.keepLogs ?? true;
  const result: UninstallResult = {
    autostartRemoved: false,
    runtimeRemoved: false,
    configRemoved: false,
    logsKept: keepLogs,
  };

  // ① 自启单元（与 installAutostart 同一目标推导——装哪删哪）
  const target = autostartTarget(opts);
  if (fs.existsSync(target.unitPath)) {
    fs.rmSync(target.unitPath, { force: true });
    result.autostartRemoved = true;
  }

  // ② runtime 整树（含全部版本目录与 current 指针）
  const root = runtimeRoot(opts);
  if (fs.existsSync(root)) {
    fs.rmSync(root, { recursive: true, force: true });
    result.runtimeRemoved = true;
  }

  // ③ config.json（setup 落盘的同一路径口径）
  const cfg =
    opts?.homeOverride !== undefined ? join(opts.homeOverride, 'config.json') : configPath();
  if (fs.existsSync(cfg)) {
    fs.rmSync(cfg, { force: true });
    result.configRemoved = true;
  }

  // ④ 日志目录 + 溯源表：默认保留；--purge-logs 才删
  if (!keepLogs) {
    const home = opts?.homeOverride ?? mechaHome();
    fs.rmSync(join(home, 'logs'), { recursive: true, force: true });
    fs.rmSync(join(home, 'provenance.json'), { force: true });
  }

  return result;
}
