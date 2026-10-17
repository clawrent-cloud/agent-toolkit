import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { installRuntime, readPkgMeta, resolvePkgDir } from '../persist/runtime-install.js';
import { MECHA_REGISTRY_LATEST_URL, runUpdate } from './update.js';

/**
 * mecha update 手动更新测试（plan Task 20）。runtime 落点全部经 R17
 * homeOverride 注入到临时目录（绝不触碰 `~/.clawrent/mecha`）；registry 与
 * tarball 下载均走 fetch 注入 mock。tarball fixture 用测试内的最小 tar
 * writer 镜像 src/cli/update.ts 的 reader 口径手工构造（512 字节头 + 数据
 * 块 + 终止块，再 gzipSync），零 fixture 文件、零新增依赖。
 *
 * 覆盖面（brief 四条 + 本地版本口径）：
 *  - mock registry 新版 → runtime 出现新版本目录且 current 切换、旧目录保留；
 *  - 同版 → updated:false 完全不动（连 tarball 都不下载）；
 *  - tarball 结构缺 dist/cli/index.js → 抛「包结构无效」且不切指针；
 *  - 坏 gzip → 响亮抛且指针不动。
 */

const PKG_ROOT = resolvePkgDir(fileURLToPath(import.meta.url));
const PKG_VERSION = readPkgMeta(PKG_ROOT).version;

function makeHome(): string {
  return fs.mkdtempSync(join(tmpdir(), 'mecha-upd-'));
}

/** 造一个假源包（供 installRuntime 铺「已装 runtime」环境）。 */
function makeFakePkg(version: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-pkg-'));
  fs.mkdirSync(join(dir, 'dist', 'cli'), { recursive: true });
  fs.writeFileSync(join(dir, 'dist', 'cli', 'index.js'), '// mecha cli stub\n');
  fs.writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@clawrent/mecha', version, type: 'module' }),
  );
  return dir;
}

// ── 最小 tar writer（镜像 update.ts reader：512 字节头 + 数据 + 终止块）──────

const BLOCK = 512;

function tarHeader(name: string, size: number): Buffer {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name, 0, 100, 'utf8'); // name[100]
  h.write('0000644\0', 100, 'utf8'); // mode
  h.write('0000000\0', 108, 'utf8'); // uid
  h.write('0000000\0', 116, 'utf8'); // gid
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'utf8'); // size[12]
  h.write('00000000000\0', 136, 'utf8'); // mtime
  h.write('        ', 148, 'utf8'); // chksum 占位（reader 不校验，写空格即可）
  h.write('0', 156, 'utf8'); // typeflag：普通文件
  h.write('ustar\0', 257, 'utf8'); // magic
  h.write('00', 263, 'utf8'); // version
  return h;
}

function buildTar(members: ReadonlyArray<{ name: string; data: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const m of members) {
    const data = Buffer.from(m.data, 'utf8');
    chunks.push(tarHeader(m.name, data.length), data);
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(BLOCK * 2, 0)); // 归档终止块
  return Buffer.concat(chunks);
}

function buildTgz(members: ReadonlyArray<{ name: string; data: string }>): Buffer {
  return gzipSync(buildTar(members));
}

// ── fetch mock：registry latest → JSON meta；tarball URL → tgz body ──────────

interface RegistryMetaLike {
  version: string;
  dist?: { tarball: string };
}

/** 记录调用序的 mock fetch：命中 registry URL 回 meta，其余回 tgz。 */
function makeFetch(meta: RegistryMetaLike, tgz: Buffer): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    calls.push(url);
    if (url === MECHA_REGISTRY_LATEST_URL) {
      return new Response(JSON.stringify(meta), { status: 200 });
    }
    return new Response(new Uint8Array(tgz), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl: impl, calls };
}

const META_020: RegistryMetaLike = {
  version: '0.2.0',
  dist: { tarball: 'https://registry.npmjs.org/@clawrent/mecha/-/mecha-0.2.0.tgz' },
};

describe('runUpdate（手动更新；spec A11：无任何远程自动触发）', () => {
  it('registry 有新版 → 下载 tarball 装入新版本目录、current 切换、旧目录保留', async () => {
    const home = makeHome();
    await installRuntime(makeFakePkg('0.1.0'), { homeOverride: home });
    const tgz = buildTgz([
      { name: 'package/package.json', data: JSON.stringify({ name: '@clawrent/mecha', version: '0.2.0' }) },
      { name: 'package/dist/cli/index.js', data: '// mecha cli v0.2.0\n' },
      { name: 'package/dist/lib.js', data: 'export const v = 2;\n' },
    ]);
    const { fetchImpl, calls } = makeFetch(META_020, tgz);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runUpdate({ fetchImpl, homeOverride: home });

    expect(calls[0]).toBe(MECHA_REGISTRY_LATEST_URL);
    expect(calls[1]).toBe(META_020.dist?.tarball);
    expect(result).toEqual({ from: '0.1.0', to: '0.2.0', updated: true });
    const v2 = join(home, 'runtime', 'v0.2.0');
    expect(fs.readFileSync(join(v2, 'dist', 'cli', 'index.js'), 'utf8')).toContain('v0.2.0');
    expect(fs.readFileSync(join(v2, 'dist', 'lib.js'), 'utf8')).toContain('v = 2');
    // runtime 里的 package.json = installRuntime 的 minimal 形
    expect(JSON.parse(fs.readFileSync(join(v2, 'package.json'), 'utf8'))).toEqual({
      name: '@clawrent/mecha',
      version: '0.2.0',
      type: 'module',
    });
    expect(fs.readFileSync(join(home, 'runtime', 'current'), 'utf8').trim()).toBe('v0.2.0');
    expect(fs.existsSync(join(home, 'runtime', 'v0.1.0'))).toBe(true); // 旧目录保留
    expect(log).toHaveBeenCalledWith(
      '已更新 v0.1.0 → v0.2.0，请重启机甲守护进程（mecha daemon 或重新开机）',
    );
    log.mockRestore();
  });

  it('同版本 → updated:false 完全不动（tarball 不下载、runtime 目录原样）', async () => {
    const home = makeHome();
    await installRuntime(makeFakePkg(PKG_VERSION), { homeOverride: home });
    const { fetchImpl, calls } = makeFetch(
      { version: PKG_VERSION, dist: { tarball: 'https://registry.npmjs.org/@clawrent/mecha/-/mecha-x.tgz' } },
      Buffer.alloc(0),
    );
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await runUpdate({ fetchImpl, homeOverride: home });

    expect(result).toEqual({ from: PKG_VERSION, to: PKG_VERSION, updated: false });
    expect(calls).toHaveLength(1); // 只查了 registry，没碰 tarball
    expect(fs.readdirSync(join(home, 'runtime')).sort()).toEqual(['current', `v${PKG_VERSION}`]);
    expect(log).toHaveBeenCalledWith(`已是最新版本 v${PKG_VERSION}`);
    log.mockRestore();
  });

  it('registry 版本更旧 → 同样 no-op 不下载（只前进不回退）', async () => {
    const home = makeHome();
    await installRuntime(makeFakePkg('9.9.9'), { homeOverride: home });
    const { fetchImpl, calls } = makeFetch(META_020, Buffer.alloc(0));

    const result = await runUpdate({ fetchImpl, homeOverride: home });

    expect(result).toEqual({ from: '9.9.9', to: '9.9.9', updated: false });
    expect(calls).toHaveLength(1);
    expect(fs.readFileSync(join(home, 'runtime', 'current'), 'utf8').trim()).toBe('v9.9.9');
  });

  it('未装 runtime → 本地版本回退运行包 package.json；同版 no-op 且不建 runtime 目录', async () => {
    const home = makeHome();
    const { fetchImpl } = makeFetch(
      { version: PKG_VERSION, dist: { tarball: 'https://registry.npmjs.org/@clawrent/mecha/-/mecha-x.tgz' } },
      Buffer.alloc(0),
    );

    const result = await runUpdate({ fetchImpl, homeOverride: home });

    expect(result).toEqual({ from: PKG_VERSION, to: PKG_VERSION, updated: false });
    expect(fs.existsSync(join(home, 'runtime'))).toBe(false);
  });

  it('tarball 缺 dist/cli/index.js → 抛「包结构无效」，不装新目录不切指针', async () => {
    const home = makeHome();
    await installRuntime(makeFakePkg('0.1.0'), { homeOverride: home });
    const tgz = buildTgz([
      { name: 'package/package.json', data: JSON.stringify({ name: '@clawrent/mecha', version: '0.2.0' }) },
      { name: 'package/dist/lib.js', data: 'export const v = 2;\n' },
    ]);
    const { fetchImpl } = makeFetch(META_020, tgz);

    await expect(runUpdate({ fetchImpl, homeOverride: home })).rejects.toThrow(/包结构无效/);

    expect(fs.readFileSync(join(home, 'runtime', 'current'), 'utf8').trim()).toBe('v0.1.0');
    expect(fs.existsSync(join(home, 'runtime', 'v0.2.0'))).toBe(false);
  });

  it('tarball 连 package.json 都没有 / 包内版本与 registry 不一致 → 同样「包结构无效」', async () => {
    const home = makeHome();
    await installRuntime(makeFakePkg('0.1.0'), { homeOverride: home });

    const noManifest = buildTgz([{ name: 'package/dist/cli/index.js', data: '// x\n' }]);
    const { fetchImpl: f1 } = makeFetch(META_020, noManifest);
    await expect(runUpdate({ fetchImpl: f1, homeOverride: home })).rejects.toThrow(/包结构无效/);

    const wrongVersion = buildTgz([
      { name: 'package/package.json', data: JSON.stringify({ name: '@clawrent/mecha', version: '9.9.9' }) },
      { name: 'package/dist/cli/index.js', data: '// x\n' },
    ]);
    const { fetchImpl: f2 } = makeFetch(META_020, wrongVersion);
    await expect(runUpdate({ fetchImpl: f2, homeOverride: home })).rejects.toThrow(/包结构无效/);

    expect(fs.readFileSync(join(home, 'runtime', 'current'), 'utf8').trim()).toBe('v0.1.0');
  });

  it('坏 gzip → 响亮抛，指针不动', async () => {
    const home = makeHome();
    await installRuntime(makeFakePkg('0.1.0'), { homeOverride: home });
    const { fetchImpl } = makeFetch(META_020, Buffer.from('this is definitely not a gzip stream'));

    await expect(runUpdate({ fetchImpl, homeOverride: home })).rejects.toThrow(/不可解压/);

    expect(fs.readFileSync(join(home, 'runtime', 'current'), 'utf8').trim()).toBe('v0.1.0');
  });

  it('registry meta 形状非法（缺 dist.tarball / 非 HTTPS tarball）→ 响亮抛', async () => {
    const home = makeHome();
    const { fetchImpl: f1 } = makeFetch({ version: '0.2.0' }, Buffer.alloc(0));
    await expect(runUpdate({ fetchImpl: f1, homeOverride: home })).rejects.toThrow(/形状非法/);

    const { fetchImpl: f2 } = makeFetch(
      { version: '0.2.0', dist: { tarball: 'http://insecure.example/x.tgz' } },
      Buffer.alloc(0),
    );
    await expect(runUpdate({ fetchImpl: f2, homeOverride: home })).rejects.toThrow();
    expect(fs.existsSync(join(home, 'runtime'))).toBe(false);
  });
});
