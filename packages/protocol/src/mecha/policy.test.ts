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

  it('win32 风格绝对路径接受(盘符正反斜杠 + UNC;0.6.2 双平台口径)', () => {
    // 平台 schema 在 Linux 容器跑:单按宿主 path.isAbsolute 会把 Windows 设备的
    // 真实白名单(D:\Docs 等)全数 400——e2e-mecha 2026-10-24 发现。
    const winDirs = ['D:\\Docs\\mecha', 'D:/Docs/mecha', '\\\\server\\share\\mecha'];
    for (const dir of winDirs) {
      const result = MechaPolicySchema.safeParse({
        dirs: [dir],
        programs: [{ name: 'node', absPath: 'D:\\tools\\node.exe' }],
        limits: MECHA_LIMITS_DEFAULTS,
      });
      expect(result.success, `dir=${dir}`).toBe(true);
    }
    // CapabilityManifest 的 scratchDir 同口径
    const manifest = {
      sessionId: 'sess-1',
      policy: { dirs: ['D:\\Docs\\mecha'], programs: [], limits: MECHA_LIMITS_DEFAULTS },
      mechaVersion: '0.6.2',
      scratchDir: 'D:\\Docs\\mecha\\.clawrent\\scratch\\sess-1',
    };
    expect(CapabilityManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('win32 口径仍拒绝相对路径(不因放宽误放行)', () => {
    for (const rel of ['Downloads', '.\\Downloads', 'Docs\\mecha', '..\\..\\etc']) {
      const result = MechaPolicySchema.safeParse({
        dirs: [rel],
        programs: [],
        limits: MECHA_LIMITS_DEFAULTS,
      });
      expect(result.success, `relative=${rel}`).toBe(false);
    }
  });

  it('limits 缺字段抛 Zod 错误', () => {
    const partial: Record<string, unknown> = { ...MECHA_LIMITS_DEFAULTS };
    delete partial['heartbeatMs'];
    const result = MechaPolicySchema.safeParse({ dirs: [DIR], programs: [], limits: partial });
    expect(result.success).toBe(false);
  });

  it('limits 形状校验:不同合法限额解析通过,非正/非整数拒绝', () => {
    // 平台侧调参不使 wire 帧过不了 schema(裁定:形状校验,数值口径归常量)
    const tuned = { ...MECHA_LIMITS_DEFAULTS, maxConcurrentExecs: 2, heartbeatMs: 15_000 };
    expect(MechaPolicySchema.safeParse({ dirs: [DIR], programs: [], limits: tuned }).success).toBe(true);
    const zero = { ...MECHA_LIMITS_DEFAULTS, heartbeatMs: 0 };
    expect(MechaPolicySchema.safeParse({ dirs: [DIR], programs: [], limits: zero }).success).toBe(false);
    const negative = { ...MECHA_LIMITS_DEFAULTS, confirmTimeoutMs: -1 };
    expect(MechaPolicySchema.safeParse({ dirs: [DIR], programs: [], limits: negative }).success).toBe(false);
    const fractional = { ...MECHA_LIMITS_DEFAULTS, maxFileBytes: 1.5 };
    expect(MechaPolicySchema.safeParse({ dirs: [DIR], programs: [], limits: fractional }).success).toBe(false);
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
