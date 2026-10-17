import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProvenanceStore } from './provenance.js';

// 合成 EACCES 缝：仅当 readFileSync 目标文件名为 eaccs-provenance.json 时抛
// EACCES——其余全部透传真实 fs（fixture 读写不受影响）。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const real = actual.readFileSync.bind(actual) as (
    p: fs.PathLike,
    o?: fs.EncodingOption,
  ) => string;
  const wrapped = ((p: fs.PathLike, o?: fs.EncodingOption) => {
    if (typeof p === 'string' && p.endsWith('eaccs-provenance.json')) {
      throw Object.assign(new Error(`synthetic EACCES: ${p}`), { code: 'EACCES' });
    }
    return real(p, o);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync: wrapped } as unknown as typeof actual;
});

// ── fixture 基建（os.tmpdir，plan 全局约束）────────────────────────────────

const created: string[] = [];

/** 每个用例独立的临时工作区（os.tmpdir() 下），统一 afterAll 清理。 */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-provenance-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 断言助手 ───────────────────────────────────────────────────────────────

/** 全部字母大小写翻转（win32 大小写不敏感语义下的"同一文件"变体）。 */
function flipCase(p: string): string {
  return p.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c));
}

// ── 用例 ───────────────────────────────────────────────────────────────────

describe('ProvenanceStore（溯源持久表）', () => {
  it('record 后 isDriverAuthored 为真；未记录路径为假', () => {
    const ws = makeWorkspace();
    const store = new ProvenanceStore(join(ws, 'provenance.json'));
    const target = join(ws, 'scripts', 'tool.js');

    expect(store.isDriverAuthored(target)).toBe(false); // 未记录：假
    store.record(target, 'hash-basic');
    expect(store.isDriverAuthored(target)).toBe(true); // 记录后：真
  });

  it('跨会话存活：同 file 路径新实例（重启模拟）仍为真', () => {
    const ws = makeWorkspace();
    const file = join(ws, 'provenance.json');
    const first = new ProvenanceStore(file);
    const target = join(ws, 'deliverable.xlsx');
    first.record(target, 'hash-1');

    // 进程重启后重新构造——登记必须从盘上回来（Review Focus #3 的存储前提）
    const reopened = new ProvenanceStore(file);
    expect(reopened.isDriverAuthored(target)).toBe(true);
  });

  it('大小写不敏感 FS 平台（win32/darwin）大小写变体为真；linux 变体为假', () => {
    const ws = makeWorkspace();
    const store = new ProvenanceStore(join(ws, 'provenance.json'));
    const target = join(ws, 'Scripts', 'Tool.JS'); // 无需真实存在：store 零 fs 判定
    store.record(target, 'hash-2');

    // 各平台钉自己的真值：win32（NTFS 默认）与 darwin（APFS 默认——不敏感但
    // 保留大小写）上变体是同一文件，必须照样判红（宁可误红不可漏红——darwin
    // 若按敏感处理，登记 Tool.js 后以 tool.js 执行即漏红）；linux 默认真敏感，
    // 变体是不同文件，不得误红。
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(store.isDriverAuthored(flipCase(target))).toBe(true);
    } else {
      expect(store.isDriverAuthored(flipCase(target))).toBe(false);
    }
    expect(store.isDriverAuthored(target)).toBe(true); // 原样路径各平台都命中

    if (process.platform === 'win32') {
      // 分隔符归一（comparableForm 口径，仅 win32）：正斜杠形式同样命中
      expect(store.isDriverAuthored(target.replace(/\\/g, '/'))).toBe(true);
    }
  });

  // ── 持久化边界（构造只读 / 自动建目录 / 损坏处置裁定）────────────────────

  it('文件不存在时构造：空表且不落盘（构造只读，写时才落）', () => {
    const ws = makeWorkspace();
    const file = join(ws, 'fresh', 'provenance.json');
    const store = new ProvenanceStore(file);

    expect(store.isDriverAuthored(join(ws, 'x'))).toBe(false); // 首启空表
    expect(fs.existsSync(file)).toBe(false); // 构造不创建文件
  });

  it('目录不存在时 record：自动建目录并同步落盘，新实例可读回', () => {
    const ws = makeWorkspace();
    const file = join(ws, 'a', 'b', 'provenance.json');
    const store = new ProvenanceStore(file);
    const target = join(ws, 'out.bin');

    store.record(target, 'hash-3');
    expect(fs.existsSync(file)).toBe(true); // 目录已建、文件已落盘
    expect(new ProvenanceStore(file).isDriverAuthored(target)).toBe(true);
  });

  it('损坏 JSON 构造：按裁定当作空表，损坏字节保留为 .bak（绝不静默吞数据），重建照常', () => {
    const ws = makeWorkspace();
    const file = join(ws, 'provenance.json');
    const corrupt = '{"entries":[{"path":"C:\\\\x","ha';
    fs.writeFileSync(file, corrupt);

    const store = new ProvenanceStore(file);
    expect(store.isDriverAuthored(join(ws, 'anything'))).toBe(false); // 当作空表
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe(corrupt); // 证据保留

    // 空表重建路径照常工作：record → 落盘 → 新实例读回
    const target = join(ws, 'rebuilt.js');
    store.record(target, 'hash-4');
    expect(new ProvenanceStore(file).isDriverAuthored(target)).toBe(true);
  });

  it('合法 JSON 但形状不可辨（entries 非数组 / entry 缺字段）：同样空表 + .bak', () => {
    const ws = makeWorkspace();
    const file = join(ws, 'provenance.json');
    fs.writeFileSync(file, '{"entries":"not-an-array"}');
    const store = new ProvenanceStore(file);
    expect(store.isDriverAuthored(join(ws, 'a'))).toBe(false);
    expect(fs.readFileSync(`${file}.bak`, 'utf8')).toBe('{"entries":"not-an-array"}');

    const file2 = join(ws, 'p2.json');
    fs.writeFileSync(file2, '{"entries":[{"path":123}]}'); // entry 缺 hash、path 非串
    const store2 = new ProvenanceStore(file2);
    expect(store2.isDriverAuthored(join(ws, 'a'))).toBe(false);
    expect(fs.existsSync(`${file2}.bak`)).toBe(true);
  });

  it('重复 record 同路径：覆盖为最新 hash，文件内单条；原始 path 原样入档（审计可读）', () => {
    const ws = makeWorkspace();
    const file = join(ws, 'provenance.json');
    const store = new ProvenanceStore(file);
    const target = join(ws, 'report.md');

    store.record(target, 'hash-old');
    store.record(target, 'hash-new');

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      entries: { path: string; hash: string }[];
    };
    expect(onDisk.entries).toEqual([{ path: target, hash: 'hash-new' }]);
  });

  // ── 契约与 fail-closed ─────────────────────────────────────────────────────

  it('绝对路径契约：构造 file / record realPath 相对路径抛 TypeError（配置错误 fail-closed）', () => {
    const ws = makeWorkspace();
    expect(() => new ProvenanceStore('rel/provenance.json')).toThrowError(/必须为绝对路径/);

    const store = new ProvenanceStore(join(ws, 'provenance.json'));
    expect(() => store.record('rel/tool.js', 'h')).toThrowError(/必须为绝对路径/);
  });

  it('构造时读取错误（合成 EACCES）：响亮抛错，绝不静默空表（判红全盲防线）', () => {
    const ws = makeWorkspace();
    // 静默空表会让后续 isDriverAuthored 全部为假 = 漏红方向；不可判定必须抛
    expect(() => new ProvenanceStore(join(ws, 'eaccs-provenance.json'))).toThrowError(
      /溯源表不可读/,
    );
  });
});
