import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  resolveTargetDir,
  assertSafePaths,
  fetchSkillBundle,
  writeSkillFiles,
} from './staff.js';

/**
 * Task 3(staff 拆 skill 线): `clawrent staff install-skill` 的可测内核。
 *
 * 纯函数(resolveTargetDir/assertSafePaths)+ IO 薄层(fetchSkillBundle/writeSkillFiles)。
 * 全程 node:path(win32 兼容)——本仓用户机是 Windows。真 skill 内容不入测试 fixture
 * (红线:npm 包不带 staff skill 内容,测试同此)。
 */

function tmpHome(): string {
  return mkdtempSync(path.join(tmpdir(), 'clawrent-staff-test-'));
}

describe('resolveTargetDir', () => {
  it('显式 claude → ~/.claude/skills/clawrent-staff', () => {
    const home = tmpHome();
    const r = resolveTargetDir('claude', home);
    expect(r).toEqual({
      kind: 'claude',
      dir: path.join(home, '.claude', 'skills', 'clawrent-staff'),
    });
  });

  it('显式 openclaw → ~/.openclaw/skills/clawrent-staff', () => {
    const home = tmpHome();
    const r = resolveTargetDir('openclaw', home);
    expect(r).toEqual({
      kind: 'openclaw',
      dir: path.join(home, '.openclaw', 'skills', 'clawrent-staff'),
    });
  });

  it('显式路径 → dir kind 原样', () => {
    const home = tmpHome();
    const explicit = path.join(home, 'custom-dir');
    expect(resolveTargetDir(explicit, home)).toEqual({ kind: 'dir', dir: explicit });
  });

  it('未指定 + 仅 claude 目录存在 → claude', () => {
    const home = tmpHome();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    expect(resolveTargetDir(undefined, home).kind).toBe('claude');
  });

  it('未指定 + 两个 harness 目录都存在 → ambiguous', () => {
    const home = tmpHome();
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    mkdirSync(path.join(home, '.openclaw'), { recursive: true });
    expect(resolveTargetDir(undefined, home)).toEqual({ kind: 'ambiguous' });
  });

  it('未指定 + 无 harness 目录 → none', () => {
    expect(resolveTargetDir(undefined, tmpHome())).toEqual({ kind: 'none' });
  });
});

describe('assertSafePaths — 路径穿越防线', () => {
  const dir = path.resolve('/tmp/skill-dir');

  it('相对文件与子目录通过', () => {
    expect(() =>
      assertSafePaths([{ path: 'SKILL.md' }, { path: 'sub/a.md' }], dir),
    ).not.toThrow();
  });

  it('.. 逃逸 → throw', () => {
    expect(() => assertSafePaths([{ path: '../evil.md' }], dir)).toThrow();
  });

  it('绝对路径 → throw', () => {
    expect(() => assertSafePaths([{ path: 'C:/Windows/evil.md' }], dir)).toThrow();
    expect(() => assertSafePaths([{ path: '/etc/passwd' }], dir)).toThrow();
  });
});

describe('fetchSkillBundle / writeSkillFiles', () => {
  const realFetch = globalThis.fetch;
  let home: string;

  beforeEach(() => {
    home = tmpHome();
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  });

  it('401 → 抛带状态码的错误(不落盘)', async () => {
    globalThis.fetch = (async () => new Response('{}', { status: 401 })) as typeof fetch;
    await expect(fetchSkillBundle('https://x.example', 'stf_clawrent_x')).rejects.toThrow(
      /401/,
    );
  });

  it('200 → 校验形状并落盘 tmp 目录,内容逐字匹配', async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          version: '1.0.0',
          files: [
            { path: 'SKILL.md', content: '# staff skill fixture\n' },
            { path: 'staff-api-reference.md', content: '# ref fixture\n' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

    const bundle = await fetchSkillBundle('https://x.example', 'dlg_clawrent_x');
    expect(bundle.version).toBe('1.0.0');
    expect(bundle.files).toHaveLength(2);

    const dir = path.join(home, 'skills', 'clawrent-staff');
    writeSkillFiles(dir, bundle.files);
    expect(existsSync(path.join(dir, 'SKILL.md'))).toBe(true);
    expect(readFileSync(path.join(dir, 'SKILL.md'), 'utf8')).toBe('# staff skill fixture\n');
    expect(readFileSync(path.join(dir, 'staff-api-reference.md'), 'utf8')).toBe('# ref fixture\n');
  });

  it('畸形包(files 非数组)→ throw', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ version: '1.0.0' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    await expect(fetchSkillBundle('https://x.example', 'stf_clawrent_x')).rejects.toThrow();
  });

  it('落盘前拦下穿越文件(端点内容被篡改的场景)', () => {
    expect(() =>
      writeSkillFiles(path.join(home, 'skills', 'clawrent-staff'), [
        { path: 'SKILL.md', content: 'ok' },
        { path: '../escape.md', content: 'evil' },
      ]),
    ).toThrow(/escape|path|traversal/i);
    expect(existsSync(path.join(home, 'escape.md'))).toBe(false);
  });
});
