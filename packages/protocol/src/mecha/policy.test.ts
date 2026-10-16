import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CapabilityManifestSchema,
  MechaPolicySchema,
  MECHA_LIMITS_DEFAULTS,
  type MechaPolicy,
  type CapabilityManifest,
} from './policy.js';

// Windows 开发机路径夹具:tmpdir 必为绝对路径
const DIR = join(tmpdir(), 'mecha-policy-test');

describe('mecha policy & capability manifest schemas', () => {
  it('合法 policy 解析通过(dirs/programs/limits 齐备)', () => {
    const policy: MechaPolicy = {
      dirs: [DIR],
      programs: [{ name: 'node', absPath: join(DIR, 'node.exe') }],
      limits: MECHA_LIMITS_DEFAULTS,
    };
    expect(MechaPolicySchema.safeParse(policy).success).toBe(true);
  });

  it('dirs 含相对路径抛 Zod 错误', () => {
    const result = MechaPolicySchema.safeParse({
      dirs: [DIR, 'Downloads'],
      programs: [],
      limits: MECHA_LIMITS_DEFAULTS,
    });
    expect(result.success).toBe(false);
  });

  it('absPath 非绝对抛 Zod 错误', () => {
    const result = MechaPolicySchema.safeParse({
      dirs: [DIR],
      programs: [{ name: 'python', absPath: 'bin/python.exe' }],
      limits: MECHA_LIMITS_DEFAULTS,
    });
    expect(result.success).toBe(false);
  });

  it('limits 缺字段抛 Zod 错误', () => {
    const partial: Record<string, unknown> = { ...MECHA_LIMITS_DEFAULTS };
    delete partial['heartbeatMs'];
    const result = MechaPolicySchema.safeParse({ dirs: [DIR], programs: [], limits: partial });
    expect(result.success).toBe(false);
  });

  it('limits 值偏离 spec §11 钉死值抛 Zod 错误(literal 钉死,不收散值)', () => {
    const drifted = { ...MECHA_LIMITS_DEFAULTS, maxConcurrentExecs: 2 };
    const result = MechaPolicySchema.safeParse({ dirs: [DIR], programs: [], limits: drifted });
    expect(result.success).toBe(false);
  });

  it('MECHA_LIMITS_DEFAULTS 各值等于 spec §11 数字', () => {
    expect(MECHA_LIMITS_DEFAULTS).toEqual({
      confirmTimeoutMs: 300_000,
      disconnectGraceMs: 60_000,
      heartbeatMs: 30_000,
      maxFileBytes: 20_971_520,
      execTimeoutDefaultMs: 600_000,
      execTimeoutMaxMs: 1_800_000,
      maxConcurrentExecs: 1,
    });
  });

  it('CapabilityManifest:合法清单解析通过,缺 scratchDir 拒绝', () => {
    const manifest: CapabilityManifest = {
      sessionId: 'sess-1',
      policy: {
        dirs: [DIR],
        programs: [{ name: 'node', absPath: join(DIR, 'node.exe') }],
        limits: MECHA_LIMITS_DEFAULTS,
      },
      mechaVersion: '0.1.0',
      scratchDir: join(DIR, 'scratch'),
    };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(true);
    const noScratch: Record<string, unknown> = { ...manifest };
    delete noScratch['scratchDir'];
    expect(CapabilityManifestSchema.safeParse(noScratch).success).toBe(false);
  });
});
