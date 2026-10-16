import { afterAll, describe, expect, it, type TestContext } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { resolveWithinWhitelist, type PathGuardResult } from './path-guard.js';

// ── fixture 基建（os.tmpdir，plan 全局约束）────────────────────────────────

const created: string[] = [];

/** 每个用例独立的临时工作区（os.tmpdir() 下），统一 afterAll 清理。 */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-path-guard-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── symlink 能力探测（plan 全局约束：Windows 无开发者模式/管理员时拒建）──────

let symlinkCapable: boolean | null = null;

/** 进程内探测一次：本平台能否建目录符号链接（探测即建即删，不落垃圾）。 */
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

function expectOk(res: PathGuardResult): string {
  if (!res.ok) throw new Error(`expected ok:true, got ${res.code}`);
  return res.real;
}

function expectDenied(res: PathGuardResult): void {
  expect(res).toEqual({ ok: false, code: 'PATH_DENIED' });
}

// ── 用例 ───────────────────────────────────────────────────────────────────

describe('resolveWithinWhitelist（文件系统硬边界）', () => {
  it('白名单内通过：相对/绝对/嵌套/白名单目录本身/带尾分隔符的条目', () => {
    const ws = makeWorkspace();
    const w = join(ws, 'whitelist');
    const sub = join(w, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const file = join(w, 'file.txt');
    fs.writeFileSync(file, 'x');

    // 相对路径（相对 cwd 解析）
    expect(resolveWithinWhitelist('whitelist/file.txt', ws, [w]).ok).toBe(true);
    // 绝对路径
    expect(resolveWithinWhitelist(file, ws, [w]).ok).toBe(true);
    // 嵌套子目录：real 是真实路径
    const nested = expectOk(resolveWithinWhitelist('whitelist/sub', ws, [w]));
    expect(nested).toBe(fs.realpathSync(sub));
    // 白名单目录本身
    const itself = expectOk(resolveWithinWhitelist('whitelist', ws, [w]));
    expect(itself).toBe(fs.realpathSync(w));
    // 白名单条目带尾分隔符同样授权
    expect(resolveWithinWhitelist('whitelist/file.txt', ws, [w + sep]).ok).toBe(true);
  });

  it('白名单内不存在的目标：realpath 逐段回退最长存在父目录后拼回剩余段', () => {
    const ws = makeWorkspace();
    const w = join(ws, 'whitelist');
    fs.mkdirSync(w);

    const real = expectOk(resolveWithinWhitelist('whitelist/new.txt', ws, [w]));
    expect(real).toBe(join(fs.realpathSync(w), 'new.txt'));
  });

  it('.. 穿越出界拒；穿越后仍落在界内则通过（按落点判，不按 .. 字面判）', () => {
    const ws = makeWorkspace();
    const w = join(ws, 'whitelist');
    fs.mkdirSync(join(w, 'sub'), { recursive: true });
    fs.writeFileSync(join(ws, 'secret.txt'), 'x');
    fs.writeFileSync(join(w, 'file.txt'), 'x');

    // 出界：落到 cwd（不在白名单）
    expectDenied(resolveWithinWhitelist('whitelist/../secret.txt', ws, [w]));
    // 出界：多段 ..
    expectDenied(resolveWithinWhitelist('whitelist/sub/../../secret.txt', ws, [w]));
    // 出界：cwd 取在白名单目录内，向上跳出
    expectDenied(resolveWithinWhitelist('..', w, [w]));
    // 界内：.. 只在白名单内部游走
    expect(resolveWithinWhitelist('whitelist/sub/../file.txt', ws, [w]).ok).toBe(true);
  });

  it('白名单目录不存在的条目不构成授权', () => {
    const ws = makeWorkspace();
    expectDenied(resolveWithinWhitelist('ghost/file.txt', ws, [join(ws, 'ghost')]));
  });

  it('相邻目录字符串前缀陷阱：whitelist vs whitelist-evil 必须段边界判定后拒', () => {
    const ws = makeWorkspace();
    const w = join(ws, 'whitelist');
    const w2 = join(ws, 'whitelist-evil');
    fs.mkdirSync(w);
    fs.mkdirSync(w2);
    fs.writeFileSync(join(w2, 'file.txt'), 'x');

    expectDenied(resolveWithinWhitelist('whitelist-evil/file.txt', ws, [w]));
  });

  it('空白名单：一律拒（fail-closed）', () => {
    const ws = makeWorkspace();
    const file = join(ws, 'file.txt');
    fs.writeFileSync(file, 'x');
    expectDenied(resolveWithinWhitelist('.', ws, []));
    expectDenied(resolveWithinWhitelist(file, ws, []));
  });

  it('拒绝结果恰为 { ok:false, code:"PATH_DENIED" }，且字面量与协议七码首位钉死', () => {
    const ws = makeWorkspace();
    expect(resolveWithinWhitelist('../outside', ws, [ws])).toEqual({
      ok: false,
      code: 'PATH_DENIED',
    });
    expect(Mecha.MECHA_ERROR_CODES[0]).toBe('PATH_DENIED');
  });

  // ── 大小写（Review Focus #1）─────────────────────────────────────────────

  it('大小写变体：win32 大小写不敏感通过，posix 按大小写拒', () => {
    const ws = makeWorkspace();
    const w = join(ws, 'whitelist');
    fs.mkdirSync(w);
    fs.writeFileSync(join(w, 'File.TXT'), 'x');

    const existingVariant = join(ws, 'WHITELIST', 'file.txt'); // 存在文件的大小写变体
    const missingVariant = join(ws, 'WHITELIST', 'absent.txt'); // 尾段不存在（走拼回路径）

    if (process.platform === 'win32') {
      expect(resolveWithinWhitelist(existingVariant, ws, [w]).ok).toBe(true);
      expect(resolveWithinWhitelist(missingVariant, ws, [w]).ok).toBe(true);
      // 盘符大小写同享不敏感
      const lowerDrive = existingVariant.replace(/^[A-Z]:/, (d) => d.toLowerCase());
      if (lowerDrive !== existingVariant) {
        expect(resolveWithinWhitelist(lowerDrive, ws, [w]).ok).toBe(true);
      }
    } else {
      expectDenied(resolveWithinWhitelist(existingVariant, ws, [w]));
      expectDenied(resolveWithinWhitelist(missingVariant, ws, [w]));
    }
  });

  // ── 符号链接出界（Review Focus #1；平台拒建时优雅跳过）────────────────────

  const itSymlink = assumeSymlinkCapable(it);

  itSymlink('白名单内符号链接指向界外文件：拒', () => {
    const ws = makeWorkspace();
    const w = join(ws, 'whitelist');
    const outside = join(ws, 'outside');
    fs.mkdirSync(w);
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, 'secret.txt'), 'x');
    fs.symlinkSync(join(outside, 'secret.txt'), join(w, 'link.txt'));

    expectDenied(resolveWithinWhitelist('whitelist/link.txt', ws, [w]));
  });

  itSymlink('白名单内符号链接指向界外目录（目录段穿透 + 不存在尾段）：拒', () => {
    const ws = makeWorkspace();
    const w = join(ws, 'whitelist');
    const outside = join(ws, 'outside');
    fs.mkdirSync(w);
    fs.mkdirSync(outside);
    fs.writeFileSync(join(outside, 'payload.txt'), 'x');
    fs.symlinkSync(outside, join(w, 'link-dir'));

    // 存在尾段：整路径 realpath 穿透符号链接落到界外
    expectDenied(resolveWithinWhitelist('whitelist/link-dir/payload.txt', ws, [w]));
    // 不存在尾段：父目录 realpath 穿透符号链接落到界外后拼回
    expectDenied(resolveWithinWhitelist('whitelist/link-dir/new.txt', ws, [w]));
  });

  itSymlink('白名单内符号链接指向界内真实文件：通过（按真实落点判）', () => {
    const ws = makeWorkspace();
    const w = join(ws, 'whitelist');
    fs.mkdirSync(w);
    const inner = join(w, 'inner.txt');
    fs.writeFileSync(inner, 'x');
    fs.symlinkSync(inner, join(w, 'link.txt'));

    const real = expectOk(resolveWithinWhitelist('whitelist/link.txt', ws, [w]));
    expect(real).toBe(fs.realpathSync(inner));
  });

  it('白名单目录本身是链接（win32 junction / posix symlink）：授权其真实指向', () => {
    const ws = makeWorkspace();
    const outside = join(ws, 'outside');
    fs.mkdirSync(outside);
    const target = join(outside, 'file.txt');
    fs.writeFileSync(target, 'x');
    const link = join(ws, 'link-w');
    if (process.platform === 'win32') {
      fs.symlinkSync(outside, link, 'junction');
    } else {
      fs.symlinkSync(outside, link, 'dir');
    }

    // 双侧真实化：白名单条目与请求路径都落到真实目录，比较按真实落点命中
    const real = expectOk(resolveWithinWhitelist('link-w/file.txt', ws, [link]));
    expect(real).toBe(fs.realpathSync(target));
  });

  // junction 是无需开发者模式/管理员即可建的 reparse point，遍历时与目录符号
  // 链接同样被 realpath 穿透——界外出界类在本机 win32 即可真实执行不跳过。
  it.runIf(process.platform === 'win32')(
    '白名单内 junction 指向界外目录：拒（reparse point 穿透）',
    () => {
      const ws = makeWorkspace();
      const w = join(ws, 'whitelist');
      const outside = join(ws, 'outside');
      fs.mkdirSync(w);
      fs.mkdirSync(outside);
      fs.writeFileSync(join(outside, 'payload.txt'), 'x');
      fs.symlinkSync(outside, join(w, 'junc-dir'), 'junction');

      expectDenied(resolveWithinWhitelist('whitelist/junc-dir/payload.txt', ws, [w]));
      expectDenied(resolveWithinWhitelist('whitelist/junc-dir/new.txt', ws, [w]));
    },
  );
});
