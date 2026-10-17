import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { DashcamLogger } from './logging.js';
import type { MechaPolicyUpdateFrame } from './session.js';
import type { ExecutorLogger } from './ops/executor.js';

// ── fixture 基建（os.tmpdir，plan 全局约束）────────────────────────────────

const created: string[] = [];

function makeWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 数据 fixture ──────────────────────────────────────────────────────────

/** 程序表钉死的 node 登记真身（风格随 session.test.ts）。 */
const NODE: Mecha.MechaProgramEntry = { name: 'node', absPath: process.execPath };

function policy(dirs: string[]): Mecha.MechaPolicy {
  return { dirs, programs: [NODE], limits: { ...Mecha.MECHA_LIMITS_DEFAULTS } };
}

function manifest(sessionId: string, ws: string): Mecha.CapabilityManifest {
  return {
    sessionId,
    policy: policy([ws]),
    mechaVersion: '0.1.0',
    scratchDir: join(ws, '.clawrent', 'scratch', sessionId),
  };
}

function envelope(
  op: Mecha.MechaOp,
  sessionId = 'sess-1',
  opId = 'op-1',
): Mecha.MechaOpEnvelope {
  return { opId, sessionId, op };
}

function okResult(opId = 'op-1', tier?: 'T1' | 'T2'): Mecha.MechaOpResult {
  return tier === undefined
    ? { opId, ok: true, value: [] }
    : { opId, ok: true, tier, value: { path: 'x' } };
}

function confirmReq(opId = 'op-1'): Mecha.MechaConfirmRequest {
  return {
    requestId: `${opId}:confirm`,
    opId,
    tier: 'T1',
    summary: '驾驶员想写入 x',
  };
}

/** 读回 JSONL：逐行 JSON.parse（坏行让断言当场炸响，绝不静默跳过）。 */
function readLines(file: string): Array<Record<string, unknown>> {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// ── 四大 brief 用例（begin/全文追责/confirm 成对/end reason）────────────────

describe('DashcamLogger brief 四用例', () => {
  it('beginSession 写 manifest：logsDir 自建、首行 session_begin 含全量 policy 快照', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logsDir = join(ws, 'logs'); // 不存在的子目录：验证构造即自建
    const logger = new DashcamLogger(logsDir);
    const m = manifest('sess-1', ws);

    logger.beginSession('sess-1', m);

    const file = join(logsDir, 'sess-1.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const lines = readLines(file);
    expect(lines).toHaveLength(1);
    const first = lines[0]!; // 上行 length 断言已钉非空
    expect(first['kind']).toBe('session_begin');
    expect(first['manifest']).toEqual(m); //「当时授权了什么」全量入档（目录+程序+限额）
    expect(first['timestamp']).toMatch(ISO_RE);
  });

  it('upload 全文可在日志读回（追责证据）：op 行 envelope verbatim + result 全量', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    logger.beginSession('sess-1', manifest('sess-1', ws));
    const content = 'console.log("audit evidence: driver script")\n'.repeat(10);
    logger.logOp(
      envelope({ type: 'file.upload', name: 'tool.js', content }, 'sess-1', 'op-up'),
      okResult('op-up', 'T1'),
    );

    const opLine = readLines(join(ws, 'sess-1.jsonl')).find(
      (l) => l['kind'] === 'op',
    )!;
    const loggedEnv = opLine['envelope'] as Mecha.MechaOpEnvelope;
    expect(loggedEnv.opId).toBe('op-up');
    expect(loggedEnv.op.type).toBe('file.upload');
    expect((loggedEnv.op as { content: string }).content).toBe(content); // 全文 verbatim
    expect(opLine['result']).toEqual(okResult('op-up', 'T1'));
    expect(opLine['timestamp']).toMatch(ISO_RE);
  });

  it('confirm 结果成对：request/result 同行同 requestId；confirmEnd 标记入档', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    logger.beginSession('sess-1', manifest('sess-1', ws));

    const approvedReq = confirmReq('op-a');
    logger.logConfirm(approvedReq, {
      requestId: approvedReq.requestId,
      approved: true,
    });
    const deniedReq = confirmReq('op-b');
    logger.logConfirm(deniedReq, {
      requestId: deniedReq.requestId,
      approved: false,
      confirmEnd: 'timeout',
    });

    const lines = readLines(join(ws, 'sess-1.jsonl')).filter(
      (l) => l['kind'] === 'confirm',
    );
    expect(lines).toHaveLength(2);
    const first = lines[0]!; // 上行 length 断言已钉非空
    expect(first['request']).toEqual(approvedReq);
    expect(first['result']).toEqual({
      requestId: approvedReq.requestId,
      approved: true,
    });
    expect(
      (first['request'] as Mecha.MechaConfirmRequest).requestId,
    ).toBe((first['result'] as { requestId: string }).requestId); // 成对
    expect(lines[1]!['result']).toMatchObject({
      approved: false,
      confirmEnd: 'timeout', //「非人拒」结局可追溯
    });
  });

  it('endSession 落 reason：末行 session_end；重复 end 幂等不抛不重落', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    logger.beginSession('sess-1', manifest('sess-1', ws));
    logger.endSession('completed');
    expect(() => logger.endSession('platform')).not.toThrow(); // daemon 重启边缘

    const ends = readLines(join(ws, 'sess-1.jsonl')).filter(
      (l) => l['kind'] === 'session_end',
    );
    expect(ends).toHaveLength(1);
    expect(ends[0]!['reason']).toBe('completed');
  });
});

// ── fail-loud（审计行绝不静默丢弃）与幂等 ─────────────────────────────────

describe('DashcamLogger fail-loud 与幂等', () => {
  it('未知 session 的 logOp 抛错（logOp before beginSession）', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    expect(() =>
      logger.logOp(envelope({ type: 'fs.list', path: '.' }, 'ghost'), okResult()),
    ).toThrow();
  });

  it('无在会话时 logConfirm / logPolicyUpdate / logLifecycle 抛错', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    expect(() =>
      logger.logConfirm(confirmReq(), { requestId: 'r', approved: true }),
    ).toThrow();
    expect(() =>
      logger.logPolicyUpdate(
        { type: 'policy.update', policy: policy([ws]), direction: 'tighten' },
        false,
      ),
    ).toThrow();
    expect(() => logger.logLifecycle('attached')).toThrow();
  });

  it('endSession 后 session 已关账：logOp 再入抛错', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    logger.beginSession('sess-1', manifest('sess-1', ws));
    logger.endSession('completed');
    expect(() =>
      logger.logOp(envelope({ type: 'fs.list', path: '.' }), okResult()),
    ).toThrow();
  });

  it('未开始过的 session endSession no-throw（daemon 重启边缘）', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    expect(() => logger.endSession('completed')).not.toThrow();
  });

  it('double beginSession 同 id：不抛、追加一行、fd 不重开（后续 logOp 正常）', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    const m = manifest('sess-1', ws);
    logger.beginSession('sess-1', m);
    logger.beginSession('sess-1', m); // 同 id 重入
    logger.logOp(envelope({ type: 'fs.list', path: '.' }), okResult());

    const lines = readLines(join(ws, 'sess-1.jsonl'));
    expect(lines.filter((l) => l['kind'] === 'session_begin')).toHaveLength(2);
    expect(lines.filter((l) => l['kind'] === 'op')).toHaveLength(1);
  });
});

// ── 行格式与记账面 ────────────────────────────────────────────────────────

describe('DashcamLogger 行格式与记账', () => {
  it('policy_update 与 lifecycle 入档；每行 JSON 合法且含 ISO timestamp', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    logger.beginSession('sess-1', manifest('sess-1', ws));
    const frame: MechaPolicyUpdateFrame = {
      type: 'policy.update',
      policy: policy([ws]),
      direction: 'tighten',
    };
    logger.logPolicyUpdate(frame, true);
    logger.logLifecycle('paused');
    logger.logLifecycle('link_down', { graceMs: 60_000 });
    logger.endSession('completed');

    const lines = readLines(join(ws, 'sess-1.jsonl'));
    for (const line of lines) {
      expect(line['timestamp']).toMatch(ISO_RE); // readLines 已验 JSON 合法
    }
    const pu = lines.find((l) => l['kind'] === 'policy_update')!;
    expect(pu['frame']).toEqual(frame); // 含被拒更新在内的全量记账
    expect(pu['applied']).toBe(true);
    const lifecycle = lines.filter((l) => l['kind'] === 'lifecycle');
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]!['event']).toBe('paused');
    expect(lifecycle[0]).not.toHaveProperty('detail'); // 缺省 detail 不落键
    expect(lifecycle[1]!['event']).toBe('link_down');
    expect(lifecycle[1]!['detail']).toEqual({ graceMs: 60_000 });
    expect(lines.at(-1)!['kind']).toBe('session_end'); // 末行恒为 session_end
  });

  it('每会话一个文件：ops 各归各文件互不串', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    logger.beginSession('sess-1', manifest('sess-1', ws));
    logger.logOp(
      envelope({ type: 'fs.list', path: '.' }, 'sess-1', 'op-1'),
      okResult('op-1'),
    );
    logger.beginSession('sess-2', manifest('sess-2', ws));
    logger.logOp(
      envelope({ type: 'fs.list', path: '.' }, 'sess-2', 'op-2'),
      okResult('op-2'),
    );
    logger.endSession('consumer_halt');

    const s1 = readLines(join(ws, 'sess-1.jsonl'));
    const s2 = readLines(join(ws, 'sess-2.jsonl'));
    const opIdOf = (l: Record<string, unknown>) =>
      (l['envelope'] as Mecha.MechaOpEnvelope | undefined)?.opId;
    expect(s1.some((l) => l['kind'] === 'op' && opIdOf(l) === 'op-1')).toBe(true);
    expect(s1.some((l) => l['kind'] === 'op' && opIdOf(l) === 'op-2')).toBe(false);
    expect(s2.some((l) => l['kind'] === 'op' && opIdOf(l) === 'op-2')).toBe(true);
    expect(s2.some((l) => l['kind'] === 'session_end')).toBe(true);
  });

  it('sessionId 路径逃逸硬拒：分隔符/点段抛错、盘上无逃逸文件', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger = new DashcamLogger(ws);
    const m = manifest('../evil', ws);
    expect(() => logger.beginSession('../evil', m)).toThrow();
    expect(() => logger.beginSession('a\\b', m)).toThrow();
    expect(() => logger.beginSession('.', m)).toThrow();
    expect(() => logger.beginSession('sess:ads', m)).toThrow(); // NTFS ADS（I1 同规则）
    expect(fs.existsSync(join(ws, 'evil.jsonl'))).toBe(false);
  });

  it('DashcamLogger 结构满足 ExecutorLogger（T16 log 接线前提）', () => {
    const ws = makeWorkspace('mecha-dashcam-');
    const logger: ExecutorLogger = new DashcamLogger(ws);
    expect(typeof logger.logOp).toBe('function');
  });
});
