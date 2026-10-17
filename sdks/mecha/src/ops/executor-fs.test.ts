import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { Mecha } from '@clawrent/protocol';
import { MechaExecutor, type ExecutorLogger } from './executor.js';
import { ProvenanceStore } from '../enforcement/provenance.js';

// ── fixture 基建（os.tmpdir，plan 全局约束）────────────────────────────────

const created: string[] = [];

/** 每个用例独立的临时工作区（os.tmpdir() 下），统一 afterAll 清理。 */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-executor-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 装配：真实 fs + 真实 ProvenanceStore + mock confirm/log ─────────────────

interface Harness {
  executor: MechaExecutor;
  confirm: ReturnType<typeof vi.fn>;
  logOp: ReturnType<typeof vi.fn>;
  provenance: ProvenanceStore;
  limits: Mecha.MechaLimits;
  ws: string;
  /** ws 的盘上规范形（win32 native realpath 展开 8.3 短名/真实大小写）——
   * executor 一律返回 guard 的 real 形态，路径断言必须以规范形构造预期。 */
  realWs: string;
  scratchDir: string;
  setDirs(dirs: string[]): void;
}

function makeHarness(opts?: {
  dirs?: string[];
  confirmApproved?: boolean;
}): Harness {
  const ws = makeWorkspace();
  const realWs = fs.realpathSync.native(ws);
  const scratchDir = join(ws, 'scratch');
  const provenance = new ProvenanceStore(join(ws, 'provenance.json'));
  const limits: Mecha.MechaLimits = { ...Mecha.MECHA_LIMITS_DEFAULTS };
  let dirs = opts?.dirs ?? [ws];
  const confirm = vi.fn(
    async (req: Mecha.MechaConfirmRequest): Promise<Mecha.MechaConfirmResult> => ({
      requestId: req.requestId,
      approved: opts?.confirmApproved ?? true,
    }),
  );
  const logOp = vi.fn();
  const log: ExecutorLogger = { logOp };
  const executor = new MechaExecutor({
    policy: () => ({ dirs, programs: [], limits }),
    provenance,
    confirm,
    log,
    scratchDir,
  });
  return {
    executor,
    confirm,
    logOp,
    provenance,
    limits,
    ws,
    realWs,
    scratchDir,
    setDirs(next: string[]) {
      dirs = next;
    },
  };
}

function env(op: Mecha.MechaOp, opId = 'op-1'): Mecha.MechaOpEnvelope {
  return { opId, sessionId: 'sess-1', op };
}

// ── 用例 ───────────────────────────────────────────────────────────────────

describe('MechaExecutor fs 原语（T0 免确认）', () => {
  it('fs.list 免确认执行成功，entries 结构化返回（real 路径 + kind + size）', async () => {
    const h = makeHarness();
    fs.writeFileSync(join(h.ws, 'a.txt'), 'hello'); // 5 字节
    fs.mkdirSync(join(h.ws, 'sub'));

    const r = await h.executor.execute(env({ type: 'fs.list', path: '.', depth: 0 }));

    expect(r.ok).toBe(true);
    expect(r.tier).toBeUndefined(); // T0 结果不带 tier
    expect(r.error).toBeUndefined();
    expect(h.confirm).not.toHaveBeenCalled();
    const entries = r.value as Array<{
      path: string;
      name: string;
      kind: 'file' | 'dir';
      size?: number;
    }>;
    expect(entries).toEqual([
      { path: join(h.realWs, 'a.txt'), name: 'a.txt', kind: 'file', size: 5 },
      { path: join(h.realWs, 'sub'), name: 'sub', kind: 'dir' },
    ]);
  });

  it('fs.read utf8 与 base64 免确认返回内容与回显 encoding', async () => {
    const h = makeHarness();
    const content = '你好 hello';
    fs.writeFileSync(join(h.ws, 't.txt'), content, 'utf8');

    const r8 = await h.executor.execute(
      env({ type: 'fs.read', path: 't.txt', encoding: 'utf8' }),
    );
    expect(r8.ok).toBe(true);
    expect(r8.tier).toBeUndefined();
    expect(r8.value).toEqual({ content, encoding: 'utf8' });

    const r64 = await h.executor.execute(
      env({ type: 'fs.read', path: 't.txt', encoding: 'base64' }, 'op-2'),
    );
    expect(r64.ok).toBe(true);
    expect(r64.value).toEqual({
      content: Buffer.from(content, 'utf8').toString('base64'),
      encoding: 'base64',
    });

    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('fs.list 支持 depth 层级展开与 glob 过滤（自实现 */** 最小匹配）', async () => {
    const h = makeHarness();
    fs.writeFileSync(join(h.ws, 'a.txt'), '1');
    fs.writeFileSync(join(h.ws, 'b.js'), '2');
    fs.mkdirSync(join(h.ws, 'sub'));
    fs.writeFileSync(join(h.ws, 'sub', 'c.txt'), '3');
    fs.mkdirSync(join(h.ws, 'sub', 'deep'));
    fs.writeFileSync(join(h.ws, 'sub', 'deep', 'd.txt'), '4');

    const namesOf = async (op: Mecha.MechaOp) => {
      const r = await h.executor.execute(env(op));
      expect(r.ok).toBe(true);
      return (r.value as Array<{ name: string }>).map((e) => e.name);
    };

    // depth 0 = 仅本层
    expect(
      await namesOf({ type: 'fs.list', path: '.', depth: 0 }),
    ).toEqual(['a.txt', 'b.js', 'sub']);
    // depth 1 = 本层 + 下一层（d.txt 在第三层，depth 1 不可达）
    expect(
      await namesOf({ type: 'fs.list', path: '.', depth: 1 }),
    ).toEqual(['a.txt', 'b.js', 'sub', 'c.txt', 'deep']);
    // glob 单 * 不跨目录段
    expect(
      await namesOf({ type: 'fs.list', path: '.', depth: 2, glob: '*.txt' }),
    ).toEqual(['a.txt']);
    // glob ** 跨任意层（含零层）
    expect(
      await namesOf({ type: 'fs.list', path: '.', depth: 1, glob: '**/*.txt' }),
    ).toEqual(['a.txt', 'c.txt']);
    expect(
      await namesOf({ type: 'fs.list', path: '.', depth: 2, glob: '**/*.txt' }),
    ).toEqual(['a.txt', 'c.txt', 'd.txt']);
  });

  it('读取目标不存在 → IO_ERROR', async () => {
    const h = makeHarness();
    const r = await h.executor.execute(
      env({ type: 'fs.read', path: 'missing.txt', encoding: 'utf8' }),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('IO_ERROR');
  });
});

describe('MechaExecutor fs.write 确认流', () => {
  it('confirm 拒绝 → CONFIRM_DENIED 且文件未写（真实 fs 断言，无部分副作用）', async () => {
    const h = makeHarness({ confirmApproved: false });

    const r = await h.executor.execute(
      env({ type: 'fs.write', path: 'out.txt', content: 'x', encoding: 'utf8' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CONFIRM_DENIED');
    expect(r.tier).toBe('T1'); // 经确认制 op 结果带 tier 供审计
    expect(fs.existsSync(join(h.ws, 'out.txt'))).toBe(false);

    // 确认请求契约：requestId 稳定方案、tier 透传、人话 summary
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const req = h.confirm.mock.calls[0]![0] as Mecha.MechaConfirmRequest;
    expect(req.requestId).toBe('op-1:confirm');
    expect(req.opId).toBe('op-1');
    expect(req.tier).toBe('T1');
    expect(req.summary).toContain('out.txt');
  });

  it('confirm 批准 → 写入真实路径 + 入溯源（sha256 内容哈希）', async () => {
    const h = makeHarness();
    const content = 'hello 世界';

    const r = await h.executor.execute(
      env({ type: 'fs.write', path: 'out.txt', content, encoding: 'utf8' }),
    );

    expect(r.ok).toBe(true);
    expect(r.tier).toBe('T1');
    expect(r.value).toEqual({ path: join(h.realWs, 'out.txt') });
    expect(fs.readFileSync(join(h.ws, 'out.txt'), 'utf8')).toBe(content);
    expect(h.provenance.isDriverAuthored(join(h.realWs, 'out.txt'))).toBe(true);
    // 溯源 hash = 写入字节的 sha256（经新实例重读验证持久化）
    const reloaded = new ProvenanceStore(join(h.ws, 'provenance.json'));
    expect(reloaded.isDriverAuthored(join(h.realWs, 'out.txt'))).toBe(true);
  });

  it('超过 maxFileBytes（默认 20MB）→ SIZE_LIMIT，不弹确认不落盘', async () => {
    const h = makeHarness();
    const big = 'a'.repeat(Mecha.MECHA_LIMITS_DEFAULTS.maxFileBytes + 1);

    const r = await h.executor.execute(
      env({ type: 'fs.write', path: 'big.bin', content: big, encoding: 'utf8' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('SIZE_LIMIT');
    expect(r.tier).toBe('T1');
    expect(h.confirm).not.toHaveBeenCalled(); // 硬限额先于人工确认
    expect(fs.existsSync(join(h.ws, 'big.bin'))).toBe(false);
  });

  it('恰好等于 maxFileBytes 边界 → 放行', async () => {
    const h = makeHarness();
    h.limits.maxFileBytes = 5;

    const r = await h.executor.execute(
      env({ type: 'fs.write', path: 'edge.txt', content: '12345', encoding: 'utf8' }),
    );

    expect(r.ok).toBe(true);
    expect(fs.readFileSync(join(h.ws, 'edge.txt'), 'utf8')).toBe('12345');
  });
});

describe('MechaExecutor 路径硬边界（path-guard 集成）', () => {
  it('相对路径按首个白名单目录解析（R9：驾驶员工作目录=首个白名单目录）', async () => {
    const dirA = makeWorkspace();
    const dirB = makeWorkspace();
    const h = makeHarness({ dirs: [dirA, dirB] });
    const realDirA = fs.realpathSync.native(dirA);

    const r = await h.executor.execute(
      env({ type: 'fs.write', path: 'rel.txt', content: 'r', encoding: 'utf8' }),
    );

    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ path: join(realDirA, 'rel.txt') }); // 落首个目录
    expect(fs.existsSync(join(dirA, 'rel.txt'))).toBe(true);
    expect(fs.existsSync(join(dirB, 'rel.txt'))).toBe(false);
    // 相对读同口径命中首个目录
    const back = await h.executor.execute(
      env({ type: 'fs.read', path: 'rel.txt', encoding: 'utf8' }, 'op-2'),
    );
    expect(back.value).toEqual({ content: 'r', encoding: 'utf8' });
  });

  it('../ 越界 → PATH_DENIED：不写盘、不弹确认', async () => {
    const h = makeHarness();

    const r = await h.executor.execute(
      env({ type: 'fs.write', path: '../escaped.txt', content: 'x', encoding: 'utf8' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PATH_DENIED');
    expect(fs.existsSync(join(h.ws, '..', 'escaped.txt'))).toBe(false);
    expect(h.confirm).not.toHaveBeenCalled(); // 白名单是硬边界，确认不可放行
  });

  it('绝对路径指向白名单外 → PATH_DENIED', async () => {
    const h = makeHarness();
    const outside = makeWorkspace();
    fs.writeFileSync(join(outside, 'secret.txt'), 's');

    const r = await h.executor.execute(
      env({ type: 'fs.read', path: join(outside, 'secret.txt'), encoding: 'utf8' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PATH_DENIED');
  });

  it('白名单为空 → 全部 fs 路径 PATH_DENIED（fail-closed）', async () => {
    const h = makeHarness({ dirs: [] });

    const r = await h.executor.execute(
      env({ type: 'fs.read', path: '.', encoding: 'utf8' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PATH_DENIED');
  });
});

describe('MechaExecutor fs.mkdir / move / copy / delete（T1 批准后）', () => {
  it('fs.mkdir 递归建目录', async () => {
    const h = makeHarness();

    const r = await h.executor.execute(env({ type: 'fs.mkdir', path: 'x/y' }));

    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ path: join(h.realWs, 'x', 'y') });
    expect(fs.existsSync(join(h.ws, 'x', 'y'))).toBe(true);
  });

  it('fs.copy / fs.move / fs.delete 在 real 上操作（交付物链路）', async () => {
    const h = makeHarness();
    fs.mkdirSync(join(h.ws, 'sub')); // move 目标目录
    fs.writeFileSync(join(h.ws, 'a.txt'), 'A');

    const cp = await h.executor.execute(
      env({ type: 'fs.copy', from: 'a.txt', to: 'b.txt' }),
    );
    expect(cp.ok).toBe(true);
    expect(cp.value).toEqual({ path: join(h.realWs, 'b.txt') });
    expect(fs.readFileSync(join(h.ws, 'b.txt'), 'utf8')).toBe('A');

    const mv = await h.executor.execute(
      env({ type: 'fs.move', from: 'b.txt', to: 'sub/b.txt' }, 'op-2'),
    );
    expect(mv.ok).toBe(true);
    expect(mv.value).toEqual({ path: join(h.realWs, 'sub', 'b.txt') });
    expect(fs.existsSync(join(h.ws, 'b.txt'))).toBe(false);
    expect(fs.readFileSync(join(h.ws, 'sub', 'b.txt'), 'utf8')).toBe('A');

    const del = await h.executor.execute(
      env({ type: 'fs.delete', path: 'sub/b.txt', recursive: false }, 'op-3'),
    );
    expect(del.ok).toBe(true);
    expect(del.value).toEqual({ path: join(h.realWs, 'sub', 'b.txt') });
    expect(fs.existsSync(join(h.ws, 'sub', 'b.txt'))).toBe(false);
  });
});

describe('MechaExecutor file.upload（会话暂存区通道）', () => {
  it('落 scratchDir、内容写盘、入溯源表', async () => {
    const h = makeHarness();
    const content = 'console.log(1);';

    const r = await h.executor.execute(
      env({ type: 'file.upload', name: 'run.js', content }),
    );

    expect(r.ok).toBe(true);
    expect(r.tier).toBe('T1');
    expect(r.value).toEqual({ path: join(h.realWs, 'scratch', 'run.js') });
    expect(fs.readFileSync(join(h.scratchDir, 'run.js'), 'utf8')).toBe(content);
    expect(h.provenance.isDriverAuthored(join(h.realWs, 'scratch', 'run.js'))).toBe(
      true,
    );
    // sha256 与写入内容一致（溯源表持久化内容核对）
    const raw = fs.readFileSync(join(h.ws, 'provenance.json'), 'utf8');
    expect(raw).toContain(
      createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex'),
    );
  });

  it('非法名字（穿越/分隔符/盘符/点段）→ IO_ERROR invalid upload name，零落盘', async () => {
    const h = makeHarness();
    const badNames = [
      '../evil.txt',
      'sub/evil.txt',
      '..\\evil.txt',
      'C:\\evil.txt',
      'C:evil.txt',
      'a:b.txt',
      '..',
      '.',
      '',
    ];

    for (const [i, name] of badNames.entries()) {
      const r = await h.executor.execute(
        env({ type: 'file.upload', name, content: 'x' }, `op-${i}`),
      );
      expect(r.ok, `name=${JSON.stringify(name)}`).toBe(false);
      expect(r.error?.code, `name=${JSON.stringify(name)}`).toBe('IO_ERROR');
      expect(r.error?.message, `name=${JSON.stringify(name)}`).toBe(
        'invalid upload name',
      );
    }

    expect(h.confirm).not.toHaveBeenCalled(); // 名字硬校验先于人工确认
    // 穿越目标零落盘（scratch 上层与 tmpdir 根都不得出现 evil.txt）
    expect(fs.existsSync(join(h.ws, 'evil.txt'))).toBe(false);
    expect(fs.existsSync(join(dirname(h.ws), 'evil.txt'))).toBe(false);
  });
});

describe('MechaExecutor 限额与审计兜底', () => {
  it('fs.read 超限文件 → SIZE_LIMIT（stat 预检，先于读取）；边界内放行', async () => {
    const h = makeHarness();
    fs.writeFileSync(join(h.ws, 'f.bin'), '12345'); // 5 字节
    h.limits.maxFileBytes = 4;

    const over = await h.executor.execute(
      env({ type: 'fs.read', path: 'f.bin', encoding: 'utf8' }),
    );
    expect(over.ok).toBe(false);
    expect(over.error?.code).toBe('SIZE_LIMIT');

    h.limits.maxFileBytes = 5;
    const edge = await h.executor.execute(
      env({ type: 'fs.read', path: 'f.bin', encoding: 'utf8' }, 'op-2'),
    );
    expect(edge.ok).toBe(true);
    expect(edge.value).toEqual({ content: '12345', encoding: 'utf8' });
  });

  it('每个 op 恰好一条 logOp(envelope, result)（成功与失败都记录）', async () => {
    const h = makeHarness();
    const okEnvelope = env({ type: 'fs.list', path: '.', depth: 0 });
    await h.executor.execute(okEnvelope);
    const badEnvelope = env(
      { type: 'fs.write', path: '../nope.txt', content: 'x', encoding: 'utf8' },
      'op-2',
    );
    await h.executor.execute(badEnvelope);

    expect(h.logOp).toHaveBeenCalledTimes(2);
    const [firstEnv, firstRes] = h.logOp.mock.calls[0]!;
    expect(firstEnv).toEqual(okEnvelope);
    expect(firstRes.ok).toBe(true);
    const [secondEnv, secondRes] = h.logOp.mock.calls[1]!;
    expect(secondEnv).toEqual(badEnvelope);
    expect(secondRes.ok).toBe(false);
    expect(secondRes.error?.code).toBe('PATH_DENIED');
  });

  it('confirm 回调抛异常 → IO_ERROR 结果返回（守护进程不炸）', async () => {
    const h = makeHarness();
    h.confirm.mockImplementationOnce(async () => {
      throw new Error('confirm channel down');
    });

    const r = await h.executor.execute(
      env({ type: 'fs.write', path: 'out.txt', content: 'x', encoding: 'utf8' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('IO_ERROR');
    expect(fs.existsSync(join(h.ws, 'out.txt'))).toBe(false);
  });

  it('exec.run v0 未接线 → PROGRAM_DENIED 硬拒（fail-closed 占位，Task 11 实接）', async () => {
    const h = makeHarness();

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['python', 'x.py'], cwd: '.' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PROGRAM_DENIED');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('scratchDir 相对路径 → 构造即 TypeError（配置错误 fail-closed，风格随 T6/T8）', () => {
    const ws = makeWorkspace();
    expect(
      () =>
        new MechaExecutor({
          policy: () => ({
            dirs: [ws],
            programs: [],
            limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
          }),
          provenance: new ProvenanceStore(join(ws, 'p.json')),
          confirm: async (req) => ({ requestId: req.requestId, approved: true }),
          log: { logOp: () => {} },
          scratchDir: 'relative/scratch',
        }),
    ).toThrow(TypeError);
  });
});
