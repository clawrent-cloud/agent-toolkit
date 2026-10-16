import { describe, it, expect } from 'vitest';
import {
  MECHA_ERROR_CODES,
  MechaExecChunkSchema,
  MechaOpEnvelopeSchema,
  MechaOpResultSchema,
  MechaOpSchema,
  type MechaOp,
  type MechaOpResult,
} from './ops.js';

// 每种驾驶原语各一例合法样本。路径/名称只是字符串——白名单解析归 path-guard 层
// (Task 10 resolveWithinWhitelist),schema 不做路径形状约束(与 policy.ts
// 「schema 只做形状校验」同一裁定)。
const legalOps: MechaOp[] = [
  { type: 'fs.list', path: 'docs', depth: 2, glob: '*.csv' },
  { type: 'fs.read', path: 'docs/report.csv', encoding: 'utf8' },
  { type: 'fs.write', path: 'out/report.csv', content: 'a,b\n1,2', encoding: 'utf8' },
  { type: 'fs.mkdir', path: 'out' },
  { type: 'fs.move', from: 'docs/a.txt', to: 'archive/a.txt' },
  { type: 'fs.copy', from: 'docs/a.txt', to: 'backup/a.txt' },
  { type: 'fs.delete', path: 'tmp', recursive: true },
  { type: 'file.upload', name: 'sort.py', content: 'print(sorted([3, 1, 2]))' },
  {
    type: 'exec.run',
    argv: ['node', 'sort.py'],
    cwd: 'docs',
    timeoutMs: 600_000,
    env: { NODE_ENV: 'production' },
  },
];

describe('mecha op primitives (MechaOpSchema)', () => {
  it('每种 op 各一例合法解析通过', () => {
    for (const op of legalOps) {
      expect(MechaOpSchema.safeParse(op).success, `${op.type} 应解析通过`).toBe(true);
    }
  });

  it('exec.run 可选字段(timeoutMs/env)省略也解析通过', () => {
    expect(
      MechaOpSchema.safeParse({ type: 'exec.run', argv: ['python', 'clean.py'], cwd: '.' }).success,
    ).toBe(true);
  });

  it('exec.run 空 argv 拒绝', () => {
    expect(MechaOpSchema.safeParse({ type: 'exec.run', argv: [], cwd: '.' }).success).toBe(false);
  });

  it('exec.run 含空串元素拒绝', () => {
    expect(
      MechaOpSchema.safeParse({ type: 'exec.run', argv: ['node', ''], cwd: '.' }).success,
    ).toBe(false);
  });

  it('fs.read encoding 非 utf8/base64 拒绝(含缺失);base64 在 read/write 两侧合法', () => {
    expect(MechaOpSchema.safeParse({ type: 'fs.read', path: 'a.png', encoding: 'hex' }).success).toBe(
      false,
    );
    expect(MechaOpSchema.safeParse({ type: 'fs.read', path: 'a.png' }).success).toBe(false);
    expect(
      MechaOpSchema.safeParse({ type: 'fs.read', path: 'a.png', encoding: 'base64' }).success,
    ).toBe(true);
    expect(
      MechaOpSchema.safeParse({ type: 'fs.write', path: 'a.png', content: 'iVBOR', encoding: 'base64' })
        .success,
    ).toBe(true);
  });

  it('未知 op type 拒绝', () => {
    expect(MechaOpSchema.safeParse({ type: 'fs.rename', from: 'a', to: 'b' }).success).toBe(false);
  });

  it('字段形状校验:depth 非负整数、timeoutMs 正整数', () => {
    expect(MechaOpSchema.safeParse({ type: 'fs.list', path: 'docs', depth: -1 }).success).toBe(false);
    expect(MechaOpSchema.safeParse({ type: 'fs.list', path: 'docs', depth: 1.5 }).success).toBe(false);
    expect(
      MechaOpSchema.safeParse({ type: 'exec.run', argv: ['node', 'x.js'], cwd: '.', timeoutMs: 0 })
        .success,
    ).toBe(false);
  });
});

describe('mecha op envelope / result / exec chunk', () => {
  it('envelope 合法解析通过,缺 opId 拒绝', () => {
    const readOp: MechaOp = { type: 'fs.read', path: 'docs/report.csv', encoding: 'utf8' };
    const envelope = { opId: 'op-1', sessionId: 'sess-1', op: readOp };
    expect(MechaOpEnvelopeSchema.safeParse(envelope).success).toBe(true);
    const noOpId: Record<string, unknown> = { ...envelope };
    delete noOpId['opId'];
    expect(MechaOpEnvelopeSchema.safeParse(noOpId).success).toBe(false);
  });

  it('result 合法解析通过(ok+tier+value / ok:false+error),error code 枚举外拒绝', () => {
    const ok: MechaOpResult = { opId: 'op-1', ok: true, tier: 'T1', value: ['report.csv'] };
    expect(MechaOpResultSchema.safeParse(ok).success).toBe(true);
    const failed: MechaOpResult = {
      opId: 'op-2',
      ok: false,
      error: { code: 'PATH_DENIED', message: 'outside whitelist dirs' },
    };
    expect(MechaOpResultSchema.safeParse(failed).success).toBe(true);
    const badCode: Record<string, unknown> = { ...failed };
    badCode['error'] = { code: 'NOT_FOUND', message: 'x' };
    expect(MechaOpResultSchema.safeParse(badCode).success).toBe(false);
    const badTier: Record<string, unknown> = { ...ok };
    badTier['tier'] = 'T0';
    expect(MechaOpResultSchema.safeParse(badTier).success).toBe(false);
  });

  it('MECHA_ERROR_CODES 七码齐全(spec verbatim)', () => {
    expect(MECHA_ERROR_CODES).toEqual([
      'PATH_DENIED',
      'PROGRAM_DENIED',
      'CONFIRM_DENIED',
      'CONFIRM_TIMEOUT',
      'EXEC_TIMEOUT',
      'SIZE_LIMIT',
      'IO_ERROR',
    ]);
  });

  it('exec chunk 合法解析通过,stream 枚举外 / 负 seq 拒绝', () => {
    const chunk = { opId: 'op-3', stream: 'stdout', data: 'sorted\n', seq: 0 };
    expect(MechaExecChunkSchema.safeParse(chunk).success).toBe(true);
    expect(MechaExecChunkSchema.safeParse({ ...chunk, stream: 'stdin' }).success).toBe(false);
    expect(MechaExecChunkSchema.safeParse({ ...chunk, seq: -1 }).success).toBe(false);
  });
});
