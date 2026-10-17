import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { MechaExecutor, type ExecutorLogger } from './executor.js';
import { ProvenanceStore } from '../enforcement/provenance.js';

// ── fixture 基建（os.tmpdir，plan 全局约束）────────────────────────────────

const created: string[] = [];

/** 每个用例独立的临时工作区（os.tmpdir() 下），统一 afterAll 清理。 */
function makeWorkspace(): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-executor-exec-'));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 装配：真实 fs + 真实 ProvenanceStore + mock confirm/log + chunk 捕获 ────

/** 程序表钉死的 node 登记真身（裸名 'node' → 本机 node.exe）。 */
const NODE: Mecha.MechaProgramEntry = { name: 'node', absPath: process.execPath };

/** T2 红卡披露语（executor confirm summary 契约 verbatim）。 */
const RED_DISCLOSURE =
  '红卡警告：此程序将以你的系统账户权限执行任意逻辑，包括读取你账户可读的任何文件并联网发送。';

interface Harness {
  executor: MechaExecutor;
  confirm: ReturnType<typeof vi.fn>;
  logOp: ReturnType<typeof vi.fn>;
  provenance: ProvenanceStore;
  limits: Mecha.MechaLimits;
  ws: string;
  /** ws 的盘上规范形（win32 native realpath 展开 8.3 短名/真实大小写）。 */
  realWs: string;
  scratchDir: string;
  /** onChunk 捕获数组（流式断言数据源）。 */
  chunks: Mecha.MechaExecChunk[];
}

function makeHarness(opts?: {
  dirs?: string[];
  programs?: Mecha.MechaProgramEntry[];
  /** 确认裁决：布尔恒定值，或按请求判定（默认全批准）。 */
  confirmApproved?: boolean | ((req: Mecha.MechaConfirmRequest) => boolean);
}): Harness {
  const ws = makeWorkspace();
  const realWs = fs.realpathSync.native(ws);
  const scratchDir = join(ws, 'scratch');
  const provenance = new ProvenanceStore(join(ws, 'provenance.json'));
  const limits: Mecha.MechaLimits = { ...Mecha.MECHA_LIMITS_DEFAULTS };
  const dirs = opts?.dirs ?? [ws];
  const programs = opts?.programs ?? [NODE];
  const decide = opts?.confirmApproved ?? true;
  const confirm = vi.fn(
    async (req: Mecha.MechaConfirmRequest): Promise<Mecha.MechaConfirmResult> => ({
      requestId: req.requestId,
      approved: typeof decide === 'function' ? decide(req) : decide,
    }),
  );
  const logOp = vi.fn();
  const log: ExecutorLogger = { logOpStart: vi.fn(), logOp };
  const chunks: Mecha.MechaExecChunk[] = [];
  const executor = new MechaExecutor({
    policy: () => ({ dirs, programs, limits }),
    provenance,
    confirm,
    log,
    scratchDir,
    onChunk: (chunk) => {
      chunks.push(chunk);
    },
  });
  return { executor, confirm, logOp, provenance, limits, ws, realWs, scratchDir, chunks };
}

function env(op: Mecha.MechaOp, opId = 'op-1'): Mecha.MechaOpEnvelope {
  return { opId, sessionId: 'sess-1', op };
}

/** 等待子进程落 started 标记文件（确定性同步：poll 而非 sleep 猜时序）。 */
async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`fixture 子进程未启动: ${file}`);
}

/** 挂起型脚本：先落 started 标记，再 setInterval 永驻（等 timeout/kill 收割）。 */
function makeHangScript(ws: string, tag: string): { script: string; started: string } {
  const script = join(ws, `${tag}-hang.cjs`);
  const started = join(ws, `${tag}.started`);
  fs.writeFileSync(
    script,
    `require('fs').writeFileSync(${JSON.stringify(started)}, 'x');\nsetInterval(() => {}, 1000);\n`,
  );
  return { script, started };
}

/** 按流重组 chunk 文本（断言数据源）。 */
function joined(chunks: Mecha.MechaExecChunk[], stream: 'stdout' | 'stderr'): string {
  return chunks
    .filter((c) => c.stream === stream)
    .map((c) => c.data)
    .join('');
}

/** 单流 seq 序列必须恰为 0..n-1（整数、从 0 严格递增）。 */
function expectSeqStrict(chunks: Mecha.MechaExecChunk[], stream: 'stdout' | 'stderr'): void {
  const seqs = chunks.filter((c) => c.stream === stream).map((c) => c.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i));
}

interface ExecValue {
  exitCode: number;
  killed: boolean;
  stdoutTail?: string;
  stderrTail?: string;
}

// ── 用例 ───────────────────────────────────────────────────────────────────

describe('exec.run：spawn 与结果（argv 直达，不经 shell）', () => {
  it('T1 exec.run：node --version 批准执行，exitCode 0，摘要无红卡披露', async () => {
    const h = makeHarness();

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', '--version'], cwd: '.' }),
    );

    expect(r.ok).toBe(true);
    expect(r.tier).toBe('T1');
    const v = r.value as ExecValue;
    expect(v.exitCode).toBe(0);
    expect(v.killed).toBe(false);
    expect(v.stdoutTail).toMatch(/^v\d+\./);
    expect(h.confirm).toHaveBeenCalledTimes(1); // T1 经确认制
    const req = h.confirm.mock.calls[0]![0] as Mecha.MechaConfirmRequest;
    expect(req.tier).toBe('T1');
    expect(req.summary).toContain('node --version');
    expect(req.summary).not.toContain('红卡警告');
  });

  it('argv 直达：含空格参数不裂（shell 拆分会破坏 JSON 形状）', async () => {
    const h = makeHarness();
    const argvScript = join(h.ws, 'argv-dump.cjs');
    fs.writeFileSync(
      argvScript,
      [
        "const fs = require('fs');",
        'const argv = process.argv.slice(2);',
        "console.log('ARGS:' + JSON.stringify(argv));",
        "console.log('EXISTS:' + fs.existsSync(argv[1]));",
      ].join('\n'),
    );
    const spacedFile = join(h.ws, 'my file with spaces.txt');
    fs.writeFileSync(spacedFile, 'payload');

    const r = await h.executor.execute(
      env({
        type: 'exec.run',
        argv: ['node', argvScript, 'hello world  with  spaces', spacedFile],
        cwd: '.',
      }),
    );

    expect(r.ok).toBe(true);
    const out = joined(h.chunks, 'stdout');
    const argsLine = out.split('\n').find((l) => l.startsWith('ARGS:'));
    expect(argsLine).toBeDefined();
    // 双空格参数原样直达进程——经 shell 会裂成多个 argv，JSON 形状即破坏
    expect(JSON.parse(argsLine!.slice('ARGS:'.length))).toEqual([
      'hello world  with  spaces',
      spacedFile,
    ]);
    expect(out).toContain('EXISTS:true'); // 空格路径作为单一 argv 元素可达
  });

  it('未登记程序裸名 → PROGRAM_DENIED；植入假 python.bat 绝不被采纳（联动 program-guard）', async () => {
    const h = makeHarness({ programs: [] });
    // 驱动在 cwd 植入假同名体——若实现经 shell/PATH/cwd 解析即被采纳
    fs.writeFileSync(
      join(h.ws, 'python.bat'),
      '@echo off\r\necho x> python-side-effect.txt\r\n',
    );
    fs.writeFileSync(join(h.ws, 'x.py'), 'print(1)');

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['python', 'x.py'], cwd: '.' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PROGRAM_DENIED');
    expect(h.confirm).not.toHaveBeenCalled(); // 硬拒不弹确认
    expect(fs.existsSync(join(h.ws, 'python-side-effect.txt'))).toBe(false);
  });

  it('裸名命中登记真身：spawn 的是登记 absPath，植入假 node.bat 不被采纳', async () => {
    const h = makeHarness({ programs: [NODE] });
    fs.writeFileSync(
      join(h.ws, 'node.bat'),
      '@echo off\r\necho x> node-side-effect.txt\r\n',
    );

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', '--version'], cwd: '.' }),
    );

    expect(r.ok).toBe(true);
    expect((r.value as ExecValue).exitCode).toBe(0);
    expect(fs.existsSync(join(h.ws, 'node-side-effect.txt'))).toBe(false);
  });
});

describe('exec.run：流式回传（MechaExecChunk）', () => {
  it('stdout/stderr 双流 chunk：seq 各自从 0 严格递增，utf8 内容重组无损（含中文）', async () => {
    const h = makeHarness();
    const streamScript = join(h.ws, 'streams.cjs');
    fs.writeFileSync(
      streamScript,
      [
        "for (const l of ['出-0', '出-1', '出-2', '出-3', '出-4']) console.log(l);",
        "for (const e of ['错-0', '错-1', '错-2']) console.error(e);",
      ].join('\n'),
    );

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', streamScript], cwd: '.' }),
    );

    expect(r.ok).toBe(true);
    const out = joined(h.chunks, 'stdout');
    const err = joined(h.chunks, 'stderr');
    expect(out).toBe('出-0\n出-1\n出-2\n出-3\n出-4\n');
    expect(err).toBe('错-0\n错-1\n错-2\n');
    expectSeqStrict(h.chunks, 'stdout');
    expectSeqStrict(h.chunks, 'stderr');
    for (const c of h.chunks) {
      expect(c.opId).toBe('op-1');
      expect(Number.isInteger(c.seq)).toBe(true);
    }
    // 尾部回传：结果 value 携带每流有界 tail
    const v = r.value as ExecValue;
    expect(v.stdoutTail).toBe('出-0\n出-1\n出-2\n出-3\n出-4\n');
    expect(v.stderrTail).toBe('错-0\n错-1\n错-2\n');
  });
});

describe('exec.run：超时与进程树收割', () => {
  it('无 timeoutMs → 按 execTimeoutDefaultMs 超时杀树：EXEC_TIMEOUT + killed + exitCode 非 0', async () => {
    const h = makeHarness();
    h.limits.execTimeoutDefaultMs = 400;
    const { script } = makeHangScript(h.ws, 'default-timeout');

    const t0 = Date.now();
    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', script], cwd: '.' }),
    );
    const elapsed = Date.now() - t0;

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('EXEC_TIMEOUT');
    const v = r.value as ExecValue;
    expect(v.killed).toBe(true);
    expect(v.exitCode).not.toBe(0); // 树杀后进程非正常退出
    expect(elapsed).toBeLessThan(10_000); // 按策略短超时收割，不吃默认 10 分钟
  });

  it('timeoutMs 超 execTimeoutMaxMs → 钳到 max（60s 请求按 400ms 收割）', async () => {
    const h = makeHarness();
    h.limits.execTimeoutMaxMs = 400;
    const { script } = makeHangScript(h.ws, 'clamp-timeout');

    const t0 = Date.now();
    const r = await h.executor.execute(
      env({
        type: 'exec.run',
        argv: ['node', script],
        cwd: '.',
        timeoutMs: 60_000,
      }),
    );
    const elapsed = Date.now() - t0;

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('EXEC_TIMEOUT');
    expect((r.value as ExecValue).killed).toBe(true);
    expect(elapsed).toBeLessThan(10_000); // 未钳制则本用例 5s vitest 超时即红
  });

  it('killActiveExec() → 运行中 exec 被杀（killed 标记），busy 槽随后释放', async () => {
    const h = makeHarness();
    const { script, started } = makeHangScript(h.ws, 'killed');

    const pA = h.executor.execute(
      env({ type: 'exec.run', argv: ['node', script], cwd: '.' }),
    );
    await waitForFile(started);

    h.executor.killActiveExec();
    const rA = await pA;
    expect(rA.ok).toBe(false);
    expect((rA.value as ExecValue).killed).toBe(true);

    // busy 槽已释放：紧接着的 exec 正常运行
    const rNext = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', '--version'], cwd: '.' }, 'op-next'),
    );
    expect(rNext.ok).toBe(true);
  });
});

describe('exec.run：并发单槽（executor 内断言防线）', () => {
  it('一个 exec 运行中，第二个 exec.run → IO_ERROR "exec busy"，不弹确认', async () => {
    const h = makeHarness();
    const { script, started } = makeHangScript(h.ws, 'busy');

    const pA = h.executor.execute(
      env({ type: 'exec.run', argv: ['node', script], cwd: '.' }),
    );
    await waitForFile(started);

    const rB = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', '--version'], cwd: '.' }, 'op-busy'),
    );
    expect(rB.ok).toBe(false);
    expect(rB.error?.code).toBe('IO_ERROR');
    expect(rB.error?.message).toBe('exec busy');
    expect(h.confirm).toHaveBeenCalledTimes(1); // 仅 A 弹过确认，B 未达确认层

    h.executor.killActiveExec();
    const rA = await pA;
    expect((rA.value as ExecValue).killed).toBe(true);
  });
});

describe('exec.run：确认流与红卡披露（T2）', () => {
  // 脚本副作用：进程若真启动必然落 side-effect.txt——未启动断言的数据源
  const T2_SCRIPT = "require('fs').writeFileSync('side-effect.txt', 'ran');";

  it('溯源脚本参数 → T2：红卡披露入摘要；拒绝 → CONFIRM_DENIED 且进程未启动', async () => {
    // 拒绝 T2、放行 T1（fs.write 建 scripting 溯源）
    const h = makeHarness({
      confirmApproved: (req) => !req.summary.includes('红卡警告'),
    });
    const w = await h.executor.execute(
      env({ type: 'fs.write', path: 't2.cjs', content: T2_SCRIPT, encoding: 'utf8' }),
    );
    expect(w.ok).toBe(true);

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', 't2.cjs'], cwd: '.' }, 'op-2'),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('CONFIRM_DENIED');
    expect(r.tier).toBe('T2'); // 判级随结果供审计
    expect(fs.existsSync(join(h.ws, 'side-effect.txt'))).toBe(false); // 进程未启动
    expect(h.confirm).toHaveBeenCalledTimes(2);
    const req = h.confirm.mock.calls[1]![0] as Mecha.MechaConfirmRequest;
    expect(req.tier).toBe('T2');
    expect(req.summary).toContain(RED_DISCLOSURE); // 红卡披露 verbatim
  });

  it('溯源脚本参数 → T2：批准 → 执行成功，副作用落地，tier 随结果', async () => {
    const h = makeHarness();
    await h.executor.execute(
      env({ type: 'fs.write', path: 't2.cjs', content: T2_SCRIPT, encoding: 'utf8' }),
    );

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', 't2.cjs'], cwd: '.' }, 'op-2'),
    );

    expect(r.ok).toBe(true);
    expect(r.tier).toBe('T2');
    expect(fs.existsSync(join(h.ws, 'side-effect.txt'))).toBe(true);
    const req = h.confirm.mock.calls[1]![0] as Mecha.MechaConfirmRequest;
    expect(req.tier).toBe('T2');
    expect(req.summary).toContain(RED_DISCLOSURE);
  });
});

describe('exec.run：cwd 边界', () => {
  it('cwd 越白名单 → PATH_DENIED（硬边界先于确认）', async () => {
    const h = makeHarness();

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', '--version'], cwd: '../outside' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('PATH_DENIED');
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('cwd 白名单内但不存在 → IO_ERROR 明确信息（spawn 失败兜底）', async () => {
    const h = makeHarness();

    const r = await h.executor.execute(
      env({ type: 'exec.run', argv: ['node', '--version'], cwd: 'no-such-dir' }),
    );

    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('IO_ERROR');
    expect(r.error?.message).toContain('启动失败');
  });
});

describe('exec.run：env 最小化（R13 裁定）', () => {
  it('子进程 env = 系统 PATH/SystemRoot 基座 ∪ op.env，守护进程自身 env 不泄漏', async () => {
    const h = makeHarness();
    const envScript = join(h.ws, 'env-dump.cjs');
    fs.writeFileSync(envScript, "console.log('ENV:' + JSON.stringify(process.env));");
    const SENTINEL = 'MECHA_EXEC_SENTINEL_DO_NOT_INHERIT';
    process.env[SENTINEL] = 'daemon-secret';

    try {
      const r = await h.executor.execute(
        env({
          type: 'exec.run',
          argv: ['node', envScript],
          cwd: '.',
          env: { MECHA_TEST_VAR: 'passed-through' },
        }),
      );

      expect(r.ok).toBe(true);
      const out = joined(h.chunks, 'stdout');
      const envLine = out.split('\n').find((l) => l.startsWith('ENV:'));
      expect(envLine).toBeDefined();
      const childEnv: Record<string, string> = JSON.parse(
        envLine!.slice('ENV:'.length),
      );
      expect(childEnv[SENTINEL]).toBeUndefined(); // 守护进程 env 绝不外泄
      expect(childEnv['MECHA_TEST_VAR']).toBe('passed-through'); // op.env 合并
      const sysPath = childEnv['PATH'] ?? childEnv['Path']; // win32 键大小写随盘上形态
      expect(typeof sysPath).toBe('string');
      expect(sysPath!.length).toBeGreaterThan(0);
    } finally {
      delete process.env[SENTINEL];
    }
  });
});
