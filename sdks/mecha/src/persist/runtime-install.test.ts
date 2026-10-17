import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autostartTarget, installAutostart } from './autostart.js';
import {
  currentRuntimeEntry,
  ensureRuntimeInstalled,
  installRuntime,
  readPkgMeta,
  resolvePkgDir,
  runtimeEntryPath,
  uninstallAll,
} from './runtime-install.js';

/**
 * runtime 自装与卸载测试（plan Task 19）。全部经 tmpdir 覆盖（R17 模式：
 * homeOverride 注入 → runtime/config/logs/provenance 全部派生其下），真实
 * fs 操作落在临时目录，绝不触碰 `~/.clawrent/mecha`。
 *
 * 覆盖面（brief 三条）：
 *  - runtime 拷贝后 `current` 指针指向版本目录且入口存在（含幂等重拷、旧版
 *    本目录保留、minimal package.json 形状）；
 *  - ensureRuntimeInstalled 的「已是当前版本则跳过」幂等门（setup 重跑不重拷）；
 *  - uninstall 后产物不存在、日志目录保留（keepLogs:false 才连日志/溯源删除）。
 */

const VERSION = '0.1.0';

/** 造一个假源包：dist/cli/index.js + dist/lib.js + package.json。 */
function makeFakePkg(version: string = VERSION): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-pkg-'));
  fs.mkdirSync(join(dir, 'dist', 'cli'), { recursive: true });
  fs.writeFileSync(join(dir, 'dist', 'cli', 'index.js'), '// mecha cli stub\n');
  fs.writeFileSync(join(dir, 'dist', 'lib.js'), 'export const stub = 1;\n');
  fs.writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@clawrent/mecha', version, type: 'module' }),
  );
  return dir;
}

/** 临时 mecha home。 */
function makeHome(): string {
  return fs.mkdtempSync(join(tmpdir(), 'mecha-home-'));
}

describe('installRuntime（runtime 自拷贝）', () => {
  it('拷贝后 current 指针指向版本目录、入口存在、minimal package.json 三字段、返回入口路径', async () => {
    const pkgDir = makeFakePkg();
    const home = makeHome();

    const entry = await installRuntime(pkgDir, { homeOverride: home });

    const vDir = join(home, 'runtime', `v${VERSION}`);
    expect(entry).toBe(runtimeEntryPath(VERSION, { homeOverride: home }));
    expect(fs.existsSync(entry)).toBe(true);
    // dist 整目录拷贝（含子目录 cli/）
    expect(fs.readFileSync(join(vDir, 'dist', 'cli', 'index.js'), 'utf8')).toContain('mecha cli stub');
    expect(fs.existsSync(join(vDir, 'dist', 'lib.js'))).toBe(true);
    // minimal package.json：恰好 name/version/type 三字段
    expect(JSON.parse(fs.readFileSync(join(vDir, 'package.json'), 'utf8'))).toEqual({
      name: '@clawrent/mecha',
      version: VERSION,
      type: 'module',
    });
    // current 指针内容 = 版本目录名
    expect(fs.readFileSync(join(home, 'runtime', 'current'), 'utf8').trim()).toBe(`v${VERSION}`);
    // 源包不被动
    expect(fs.existsSync(join(pkgDir, 'node_modules'))).toBe(false);
    expect(fs.readdirSync(pkgDir).sort()).toEqual(['dist', 'package.json']);
  });

  it('幂等重装：同版本重拷覆盖（源文件更新后重装反映新内容）', async () => {
    const pkgDir = makeFakePkg();
    const home = makeHome();
    await installRuntime(pkgDir, { homeOverride: home });

    fs.writeFileSync(join(pkgDir, 'dist', 'cli', 'index.js'), '// updated stub\n');
    const entry2 = await installRuntime(pkgDir, { homeOverride: home });

    expect(entry2).toBe(runtimeEntryPath(VERSION, { homeOverride: home }));
    expect(fs.readFileSync(entry2, 'utf8')).toContain('updated stub');
    // 只有一个版本目录
    expect(fs.readdirSync(join(home, 'runtime')).sort()).toEqual(['current', `v${VERSION}`]);
  });

  it('新版本装入新目录、current 切换；旧版本目录保留（T20 update 管理其生命周期）', async () => {
    const home = makeHome();
    await installRuntime(makeFakePkg('0.1.0'), { homeOverride: home });
    const entry2 = await installRuntime(makeFakePkg('0.2.0'), { homeOverride: home });

    expect(entry2).toBe(runtimeEntryPath('0.2.0', { homeOverride: home }));
    expect(fs.existsSync(join(home, 'runtime', 'v0.1.0', 'dist', 'cli', 'index.js'))).toBe(true);
    expect(fs.existsSync(join(home, 'runtime', 'v0.2.0', 'dist', 'cli', 'index.js'))).toBe(true);
    expect(fs.readFileSync(join(home, 'runtime', 'current'), 'utf8').trim()).toBe('v0.2.0');
    expect(currentRuntimeEntry({ homeOverride: home })).toBe(entry2);
  });

  it('源包缺 CLI 入口（未 build）或 package.json 缺版本 → 响亮拒绝、不写半个 runtime', async () => {
    const home = makeHome();
    const noEntry = makeFakePkg();
    fs.rmSync(join(noEntry, 'dist', 'cli'), { recursive: true });
    await expect(installRuntime(noEntry, { homeOverride: home })).rejects.toThrow(/CLI 入口/);
    expect(fs.existsSync(join(home, 'runtime'))).toBe(false);

    const noVersion = makeFakePkg();
    fs.writeFileSync(
      join(noVersion, 'package.json'),
      JSON.stringify({ name: '@clawrent/mecha', type: 'module' }),
    );
    await expect(installRuntime(noVersion, { homeOverride: home })).rejects.toThrow(/version/);

    const noManifest = makeFakePkg();
    fs.rmSync(join(noManifest, 'package.json'));
    await expect(installRuntime(noManifest, { homeOverride: home })).rejects.toThrow();
  });
});

describe('currentRuntimeEntry / ensureRuntimeInstalled（幂等门）', () => {
  it('未安装 → null；指针指向不存在的版本目录 → null（指针污染不外泄路径）', () => {
    const home = makeHome();
    expect(currentRuntimeEntry({ homeOverride: home })).toBe(null);
    fs.mkdirSync(join(home, 'runtime'), { recursive: true });
    fs.writeFileSync(join(home, 'runtime', 'current'), 'v9.9.9\n');
    expect(currentRuntimeEntry({ homeOverride: home })).toBe(null);
  });

  it('ensureRuntimeInstalled：首调安装；同版本再调跳过（不重拷）；新版本再调升级', async () => {
    const pkgDir = makeFakePkg();
    const home = makeHome();

    const entry1 = await ensureRuntimeInstalled(pkgDir, { homeOverride: home });
    expect(entry1).toBe(runtimeEntryPath(VERSION, { homeOverride: home }));

    // 篡改已装副本——同版本再调应跳过（副本不被重拷覆盖）
    fs.appendFileSync(entry1, '\n// tampered\n');
    const entry1b = await ensureRuntimeInstalled(pkgDir, { homeOverride: home });
    expect(entry1b).toBe(entry1);
    expect(fs.readFileSync(entry1, 'utf8')).toContain('tampered');

    // 新版本 → 重新安装并切换
    fs.writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@clawrent/mecha', version: '0.2.0', type: 'module' }));
    const entry2 = await ensureRuntimeInstalled(pkgDir, { homeOverride: home });
    expect(entry2).toBe(runtimeEntryPath('0.2.0', { homeOverride: home }));
    expect(fs.readFileSync(entry2, 'utf8')).not.toContain('tampered');
    expect(fs.readFileSync(join(home, 'runtime', 'current'), 'utf8').trim()).toBe('v0.2.0');
  });
});

describe('resolvePkgDir / readPkgMeta', () => {
  it('resolvePkgDir 从模块文件向上找到本包根（package.json name = @clawrent/mecha）', () => {
    const dir = resolvePkgDir(fileURLToPath(import.meta.url));
    expect(JSON.parse(fs.readFileSync(join(dir, 'package.json'), 'utf8'))).toMatchObject({
      name: '@clawrent/mecha',
    });
    // 兼容 import.meta.url 直传（内部 fileURLToPath 双重转换无害）
    expect(resolvePkgDir()).toBe(dir);
  });

  it('readPkgMeta 取 name/version；缺文件/缺字段响亮拒绝', () => {
    const pkgDir = makeFakePkg('9.9.9');
    expect(readPkgMeta(pkgDir)).toEqual({ name: '@clawrent/mecha', version: '9.9.9' });
    expect(() => readPkgMeta(join(pkgDir, 'dist'))).toThrow();
  });
});

describe('uninstallAll（卸载：自启 + runtime + config；日志/溯源默认保留）', () => {
  const WIN32 = process.platform === 'win32';

  /** 铺一个「已安装」环境：runtime + config + 日志 + 溯源 + 自启单元。 */
  async function installEverything() {
    const home = fs.mkdtempSync(join(tmpdir(), 'mecha-uninst-'));
    const roamingOverride = join(home, 'roaming');
    const autostartOpts = WIN32 ? { roamingOverride } : {};
    const opts = { homeOverride: home, roamingOverride };
    const entry = await installRuntime(makeFakePkg(), opts);
    await installAutostart(entry, autostartOpts);
    fs.writeFileSync(join(home, 'config.json'), '{}\n');
    fs.mkdirSync(join(home, 'logs'), { recursive: true });
    fs.writeFileSync(join(home, 'logs', 's1.jsonl'), '{}\n');
    fs.writeFileSync(join(home, 'provenance.json'), '{}\n');
    return { home, opts, autostartOpts };
  }

  it('卸载后自启单元/runtime/config 不存在；日志目录与 provenance 保留（默认）', async () => {
    const { home, opts, autostartOpts } = await installEverything();
    const unitPath = autostartTarget(autostartOpts).unitPath;
    expect(fs.existsSync(unitPath)).toBe(true);

    const result = await uninstallAll(opts);

    expect(result).toMatchObject({ autostartRemoved: true, runtimeRemoved: true, configRemoved: true, logsKept: true });
    expect(fs.existsSync(unitPath)).toBe(false);
    expect(fs.existsSync(join(home, 'runtime'))).toBe(false);
    expect(fs.existsSync(join(home, 'config.json'))).toBe(false);
    expect(fs.existsSync(join(home, 'logs', 's1.jsonl'))).toBe(true);
    expect(fs.existsSync(join(home, 'provenance.json'))).toBe(true);
  });

  it('keepLogs:false 连日志目录与溯源表一并删除', async () => {
    const { home, opts } = await installEverything();
    const result = await uninstallAll({ ...opts, keepLogs: false });
    expect(result.logsKept).toBe(false);
    expect(fs.existsSync(join(home, 'logs'))).toBe(false);
    expect(fs.existsSync(join(home, 'provenance.json'))).toBe(false);
    expect(fs.existsSync(join(home, 'runtime'))).toBe(false);
  });

  it('空环境卸载幂等：全 false 旗标、不抛（重复 uninstall 安全）', async () => {
    const home = makeHome();
    const result = await uninstallAll({ homeOverride: home });
    expect(result).toMatchObject({ autostartRemoved: false, runtimeRemoved: false, configRemoved: false });
    await expect(uninstallAll({ homeOverride: home })).resolves.toBeTruthy();
  });
});
