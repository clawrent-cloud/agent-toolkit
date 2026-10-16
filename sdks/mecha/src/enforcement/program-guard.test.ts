import { afterAll, describe, expect, it, vi, type TestContext } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { matchProgram, type ProgramGuardResult } from './program-guard.js';

// 合成 EACCES 缝：仅当 realpathSync(.native) 对名为 eaccs-dir 的段抛 ENOENT
// 时翻译成 EACCES——其余全部透传真实 fs（fixture 读写不受影响）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const syntheticEaccs = (p: fs.PathLike): never => {
    throw Object.assign(new Error(`synthetic EACCES: ${String(p)}`), { code: 'EACCES' });
  };
  // 仅当 realpath* 对 basename 为 eaccs-dir 的段抛 ENOENT 时翻译为 EACCES
  const wrap = (real: (p: fs.PathLike) => string) =>
    ((p: fs.PathLike) => {
      try {
        return real(p);
      } catch (err) {
        const isMarker =
          (err as NodeJS.ErrnoException)?.code === 'ENOENT' &&
          typeof p === 'string' &&
          p.split(/[\\/]/).pop() === 'eaccs-dir';
        if (isMarker) throw syntheticEaccs(p);
        throw err;
      }
    }) as typeof real;
  return {
    ...actual,
    realpathSync: Object.assign(wrap(actual.realpathSync.bind(actual)), {
      native: wrap(actual.realpathSync.native.bind(actual)),
    }),
  } as unknown as typeof actual;
});

// ── fixture 基建（os.tmpdir，plan 全局约束）────────────────────────────────

const created: string[] = [];

/** 每个用例独立的临时工作区（os.tmpdir() 下），统一 afterAll 清理。 */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-program-guard-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── symlink 能力探测（plan 全局约束：Windows 无开发者模式/管理员时拒建）──────

let symlinkCapable: boolean | null = null;

/** 进程内探测一次：本平台能否建符号链接（探测即建即删，不落垃圾）。 */
function canCreateSymlinks(): boolean {
  if (symlinkCapable === null) {
    const probeDir = fs.mkdtempSync(join(tmpdir(), 'mecha-symlink-probe-'));
    try {
      fs.symlinkSync(probeDir, join(probeDir, 'probe'), 'dir');
      symlinkCapable = true;
    } catch {
      symlinkCapable = false;
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
    }
  }
  return symlinkCapable;
}

type TestFn = (ctx: TestContext) => void | Promise<void>;

/**
 * Windows 建符号链接需开发者模式/管理员——平台拒绝时优雅跳过该用例（跳过态
 * 可见，不冒充通过）。用法：`const itSymlink = assumeSymlinkCapable(it);`
 */
function assumeSymlinkCapable(
  it: (name: string, fn: TestFn) => void,
): (name: string, fn: TestFn) => void {
  return (name, fn) => {
    it(name, async (ctx) => {
      if (!canCreateSymlinks()) {
        ctx.skip();
        return;
      }
      await fn(ctx);
    });
  };
}

// ── 断言助手 ───────────────────────────────────────────────────────────────

/** 规范形（与实现同源口径）：win32 native——盘上真实大小写 + 展开 8.3 短名。 */
const CANONICAL = (p: string): string =>
  process.platform === 'win32' ? fs.realpathSync.native(p) : fs.realpathSync(p);

function expectOk(res: ProgramGuardResult): string {
  if (!res.ok) throw new Error(`expected ok:true, got ${res.code}`);
  return res.absPath;
}

function expectDenied(res: ProgramGuardResult): void {
  expect(res).toEqual({ ok: false, code: 'PROGRAM_DENIED' });
}

/** 在 ws 下落一个真实存在的登记程序文件（返回其路径）。 */
function plantProgram(ws: string, rel: string): string {
  const p = join(ws, rel);
  fs.mkdirSync(join(p, '..'), { recursive: true });
  fs.writeFileSync(p, 'real');
  return p;
}

// ── 用例 ───────────────────────────────────────────────────────────────────

describe('matchProgram（程序白名单硬边界）', () => {
  it('裸名命中表：返回登记真身 absPath（零 fs 访问——登记路径不存在也按表放行）', () => {
    const ws = makeWorkspace();
    const registered = plantProgram(ws, join('registered', 'python.exe'));

    const res = matchProgram('python', [{ name: 'python', absPath: registered }]);
    expect(expectOk(res)).toBe(registered); // 登记真身原样返回（非 fs 解析产物）

    // 零 fs 访问钉死：登记路径不存在也按表放行——不存在由 exec 层 spawn 失败
    // 兜底（表内容本就在驱动手中的 CapabilityManifest 里，无信息泄露面）
    const ghostPath = join(ws, 'no-such-dir', 'prog.exe');
    const ghost = matchProgram('ghost', [{ name: 'ghost', absPath: ghostPath }]);
    expect(expectOk(ghost)).toBe(ghostPath);
  });

  it('裸名不在表拒：未知名/./../空串/~ 一律拒（绝不文件系统搜索）', () => {
    const ws = makeWorkspace();
    const registered = plantProgram(ws, join('bin', 'python.exe'));
    const programs = [{ name: 'python', absPath: registered }];

    expectDenied(matchProgram('gcc', programs));
    expectDenied(matchProgram('.', programs));
    expectDenied(matchProgram('..', programs));
    expectDenied(matchProgram('', programs));
    expectDenied(matchProgram('~', programs));
  });

  it('裸名精确匹配：大小写变体不命中（fail-closed；要支持变体由平台登记变体）', () => {
    const ws = makeWorkspace();
    const registered = plantProgram(ws, join('bin', 'python.exe'));
    const programs = [{ name: 'python', absPath: registered }];

    expectDenied(matchProgram('Python', programs));
    expectDenied(matchProgram('PYTHON', programs));
  });

  // ── Review Focus #2：假同名程序植入——硬拒，绝不路径搜索 ──────────────────

  it('植入假 python.bat 后裸名 python 依然拒；表内有 python 时命中登记真身而非植入体（Review Focus #2）', () => {
    const ws = makeWorkspace();
    // 模拟驱动在可写目录（白名单目录/PATH 目录/cwd）植入的假同名程序
    fs.writeFileSync(join(ws, 'python.bat'), 'evil');
    fs.writeFileSync(join(ws, 'python'), 'evil');
    fs.writeFileSync(join(ws, 'python.exe'), 'evil');
    const systemReal = plantProgram(ws, join('system', 'python.exe')); // 模拟登记真身

    // 表内没有 python：裸名必须拒——哪怕同目录躺着 python/python.bat/python.exe
    expectDenied(matchProgram('python', [{ name: 'node', absPath: systemReal }]));

    // 表内有 python：命中登记真身，绝非植入体
    expect(expectOk(matchProgram('python', [{ name: 'python', absPath: systemReal }]))).toBe(
      systemReal,
    );

    // 驱动显式把植入体路径当绝对路径提交：同样拒（路径分支精确相等）
    expectDenied(
      matchProgram(join(ws, 'python.bat'), [{ name: 'python', absPath: systemReal }]),
    );
    expectDenied(matchProgram(join(ws, 'python'), [{ name: 'python', absPath: systemReal }]));
    expectDenied(
      matchProgram(join(ws, 'python.exe'), [{ name: 'python', absPath: systemReal }]),
    );
  });

  // ── 路径输入分支 ──────────────────────────────────────────────────────────

  it('绝对路径=登记路径通过（返回规范形）；win32 大小写/分隔符变体通过，posix 变体拒', () => {
    const ws = makeWorkspace();
    const registered = plantProgram(ws, join('bin', 'Python.EXE'));
    const programs = [{ name: 'python', absPath: registered }];

    // 精确同形通过，返回规范形（盘上真实路径——检查对象即操作对象）
    expect(expectOk(matchProgram(registered, programs))).toBe(CANONICAL(registered));

    if (process.platform === 'win32') {
      // 大小写变体（目录与文件名整段翻转）：同一文件，native realpath 归一
      const variant = join(ws, 'BIN', 'python.exe');
      expect(expectOk(matchProgram(variant, programs))).toBe(CANONICAL(registered));
      // 正斜杠分隔符形式同样归一
      expect(matchProgram(registered.replace(/\\/g, '/'), programs).ok).toBe(true);
    } else {
      // posix 大小写敏感：变体是不同文件，拒
      expectDenied(matchProgram(join(ws, 'BIN', 'python.exe'), programs));
    }
  });

  it('相对路径输入一律拒（解析基座将是攻击者可控 cwd，永不解析）', () => {
    const ws = makeWorkspace();
    const registered = plantProgram(ws, join('bin', 'python.exe'));
    const programs = [{ name: 'python', absPath: registered }];

    expectDenied(matchProgram('./python', programs));
    expectDenied(matchProgram('scripts/python.bat', programs));
    expectDenied(matchProgram('../python', programs));
    // 即使形式上指向表内真身所在目录也不放行（相对基座不可信）
    expectDenied(matchProgram('bin/python.exe', programs));
  });

  it('绝对路径不存在：拒', () => {
    const ws = makeWorkspace();
    const registered = plantProgram(ws, join('bin', 'python.exe'));
    expectDenied(
      matchProgram(join(ws, 'absent-dir', 'prog.exe'), [
        { name: 'python', absPath: registered },
      ]),
    );
  });

  it('精确相等而非前缀：登记 python.exe，输入 python.exe.bak 拒', () => {
    const ws = makeWorkspace();
    const registered = plantProgram(ws, join('bin', 'python.exe'));
    const sibling = plantProgram(ws, join('bin', 'python.exe.bak'));
    expectDenied(matchProgram(sibling, [{ name: 'python', absPath: registered }]));
  });

  // ── 符号链接改指向（Review Focus #2 变体；平台拒建时优雅跳过）────────────

  const itSymlink = assumeSymlinkCapable(it);

  itSymlink('符号链接改指向表外二进制：改向前通过（按真实落点），改向后拒', () => {
    const ws = makeWorkspace();
    const registered = plantProgram(ws, join('registered', 'true-python.exe'));
    const evil = plantProgram(ws, join('evil-bin', 'evil.exe'));
    const link = join(ws, 'python-link');
    const programs = [{ name: 'python', absPath: registered }];

    fs.symlinkSync(registered, link); // 文件符号链接 → 登记真身
    expect(expectOk(matchProgram(link, programs))).toBe(CANONICAL(registered));

    // 改指向表外二进制：realpath 落点不在表——拒
    fs.unlinkSync(link);
    fs.symlinkSync(evil, link);
    expectDenied(matchProgram(link, programs));
  });

  // junction 是无需开发者模式/管理员即可建的 reparse point，遍历时与符号链接
  // 同样被 realpath 穿透——穿透拒类在本机 win32 即可真实执行不跳过。
  it.runIf(process.platform === 'win32')(
    'junction 穿透：指向登记目录通过（返回真实落点）、指向植入目录拒',
    () => {
      const ws = makeWorkspace();
      const regBin = join(ws, 'reg-bin');
      const registered = plantProgram(ws, join('reg-bin', 'python.exe'));
      plantProgram(ws, join('evil-bin', 'python.exe')); // 植入目录里的同名假体
      const programs = [{ name: 'python', absPath: registered }];

      fs.symlinkSync(regBin, join(ws, 'junc-reg'), 'junction');
      fs.symlinkSync(join(ws, 'evil-bin'), join(ws, 'junc-evil'), 'junction');

      expect(
        expectOk(matchProgram(join(ws, 'junc-reg', 'python.exe'), programs)),
      ).toBe(CANONICAL(registered));
      expectDenied(matchProgram(join(ws, 'junc-evil', 'python.exe'), programs));
    },
  );

  // ── 参数契约：程序表条目 absPath 必须绝对路径（配置错误 fail-closed 抛错）──

  it('程序表条目 absPath 相对/空：抛 TypeError（配置错误，不做静默解析）', () => {
    const ws = makeWorkspace();
    expect(() =>
      matchProgram('python', [{ name: 'python', absPath: 'rel/python' }]),
    ).toThrowError(/必须为绝对路径/);
    expect(() => matchProgram('python', [{ name: 'python', absPath: '' }])).toThrowError(
      /必须为绝对路径/,
    );
    // 混合条目：合法条目在前也要抛（upfront 校验，契约确定性）
    const good = plantProgram(ws, join('bin', 'node.exe'));
    expect(() =>
      matchProgram(
        'python',
        [{ name: 'node', absPath: good }, { name: 'python', absPath: 'rel' }],
      ),
    ).toThrowError(/必须为绝对路径/);
  });

  // ── 结果形状与协议钉死 ────────────────────────────────────────────────────

  it('拒绝结果恰为 { ok:false, code:"PROGRAM_DENIED" }，且字面量与协议七码第二位钉死', () => {
    expect(matchProgram('whatever', [{ name: 'other', absPath: '/x/y' }])).toEqual({
      ok: false,
      code: 'PROGRAM_DENIED',
    });
    expect(Mecha.MECHA_ERROR_CODES[1]).toBe('PROGRAM_DENIED');
  });

  // ── 非 ENOENT（不可判定）硬拒 ─────────────────────────────────────────────

  it('非 ENOENT（合成 EACCES）不可判定：argv0 侧与条目侧都硬拒，绝不误放行', () => {
    const ws = makeWorkspace();
    const real = plantProgram(ws, join('bin', 'python.exe'));

    // argv0 侧：realpath 抛非 ENOENT → 不可判定 → 以 PROGRAM_DENIED 拒（绝不
    // 抛异常穿透调用方，也绝不乐观放行）
    expectDenied(
      matchProgram(join(ws, 'eaccs-dir', 'prog.exe'), [
        { name: 'python', absPath: real },
      ]),
    );

    // 条目侧：登记真身不可真实化 → 该条目不构成授权；其余（可真实化但不匹配
    // 的）条目照常参与比较，结果仍是拒
    const other = plantProgram(ws, join('bin', 'other.exe'));
    const unrelated = plantProgram(ws, join('bin', 'unrelated.exe'));
    expectDenied(
      matchProgram(other, [
        { name: 'ghost', absPath: join(ws, 'eaccs-dir', 'prog.exe') }, // realpath EACCES → 跳过
        { name: 'other', absPath: unrelated }, // 存在但不匹配
      ]),
    );
    // 对照：同一张表里可真实化的条目照常授权
    expect(expectOk(matchProgram(real, [{ name: 'ghost', absPath: join(ws, 'eaccs-dir', 'prog.exe') }, { name: 'py', absPath: real }]))).toBe(
      CANONICAL(real),
    );
  });
});
