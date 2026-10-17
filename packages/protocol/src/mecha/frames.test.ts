import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MECHA_SESSION_END_REASONS, MechaDeviceFrameSchema, type MechaDeviceFrame } from './frames.js';
import {
  MechaConfirmRequestSchema,
  MechaConfirmResultSchema,
  type MechaConfirmRequest,
  type MechaConfirmResult,
} from './confirm.js';
import { MECHA_LIMITS_DEFAULTS, type CapabilityManifest, type MechaPolicy } from './policy.js';

// Windows 开发机路径夹具:tmpdir 必为绝对路径(policy.test.ts 同款)
const DIR = join(tmpdir(), 'mecha-frames-test');
const POLICY: MechaPolicy = {
  dirs: [DIR],
  programs: [{ name: 'node', absPath: join(DIR, 'node.exe') }],
  limits: MECHA_LIMITS_DEFAULTS,
};

// session.manifest 的最小合法清单(attach 后回执的本会话能力快照;
// scratchDir 须绝对路径——AbsolutePathSchema 同 policy.test.ts 口径)。
const MANIFEST: CapabilityManifest = {
  sessionId: 'sess-1',
  policy: POLICY,
  mechaVersion: '0.1.1',
  scratchDir: join(DIR, '.clawrent', 'scratch', 'sess-1'),
};

// 每种帧各一例合法样本(上行 = 设备 → 平台;下行 = 平台 → 设备)。
// policy.update 收录 expand 带授权 / tighten 缺省授权两形,钉死两分支。
const legalFrames: MechaDeviceFrame[] = [
  // 上行
  { type: 'device.hello', deviceId: 'mecha-001', mechaVersion: '0.1.0' },
  { type: 'heartbeat' },
  { type: 'session.accept', sessionId: 'sess-1' },
  { type: 'session.reject', reason: 'device busy with another session' },
  { type: 'session.manifest', sessionId: 'sess-1', manifest: MANIFEST },
  // 下行
  { type: 'device.welcome', serverTime: '2026-10-17T00:00:00.000Z' },
  {
    type: 'session.offer',
    sessionId: 'sess-1',
    orderRef: 'ord-1',
    driverAgentId: 'agent-driver-1',
    policy: POLICY,
    expiresAt: '2026-10-17T00:05:00.000Z',
  },
  { type: 'session.pause' },
  { type: 'session.resume' },
  { type: 'session.end', reason: 'completed' },
  { type: 'policy.update', policy: POLICY, authorizationRef: 'auth-1', direction: 'expand' },
  { type: 'policy.update', policy: POLICY, direction: 'tighten' },
  { type: 'heartbeat_ack' },
  { type: 'error', code: 'SESSION_NOT_FOUND', message: 'no active session' },
];

describe('mecha device frames (MechaDeviceFrameSchema)', () => {
  it('每种帧 type 各一例合法解析通过,且 round-trip 保形', () => {
    for (const frame of legalFrames) {
      const result = MechaDeviceFrameSchema.safeParse(frame);
      expect(result.success, `${frame.type} 应解析通过`).toBe(true);
      if (result.success) {
        expect(result.data, `${frame.type} round-trip 应保形`).toEqual(frame);
      }
    }
  });

  it('device.hello 带 token 解析通过且 round-trip 保形;无 token 仍解析通过(T17 additive 兼容)', () => {
    const withToken = {
      type: 'device.hello',
      deviceId: 'mecha-002',
      mechaVersion: '0.1.0',
      token: 'devtok-abc123',
    };
    const result = MechaDeviceFrameSchema.safeParse(withToken);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(withToken);
    }
    // 无 token 仍合法（旧设备 / 不带鉴权的 mock relay 测试不受影响）
    expect(
      MechaDeviceFrameSchema.safeParse({
        type: 'device.hello',
        deviceId: 'mecha-002',
        mechaVersion: '0.1.0',
      }).success,
    ).toBe(true);
  });

  it('device.hello token 空串拒绝(min(1)——有 token 字段就必须非空)', () => {
    expect(
      MechaDeviceFrameSchema.safeParse({
        type: 'device.hello',
        deviceId: 'mecha-002',
        mechaVersion: '0.1.0',
        token: '',
      }).success,
    ).toBe(false);
  });

  it('未知帧 type 拒绝', () => {
    expect(
      MechaDeviceFrameSchema.safeParse({ type: 'session.rename', sessionId: 'x' }).success,
    ).toBe(false);
  });

  it('session.end reason 枚举外 / 缺失拒绝', () => {
    expect(MechaDeviceFrameSchema.safeParse({ type: 'session.end', reason: 'timeout' }).success).toBe(
      false,
    );
    expect(MechaDeviceFrameSchema.safeParse({ type: 'session.end' }).success).toBe(false);
  });

  it('MECHA_SESSION_END_REASONS 六值齐全(spec verbatim)', () => {
    expect(MECHA_SESSION_END_REASONS).toEqual([
      'completed',
      'consumer_disconnect',
      'grace_expired',
      'balance_exhausted',
      'platform',
      'consumer_halt',
    ]);
  });

  it('policy.update direction=expand 缺 authorizationRef 拒绝(空串也拒绝),issue 落在 authorizationRef 路径', () => {
    const missing = { type: 'policy.update', policy: POLICY, direction: 'expand' };
    const result = MechaDeviceFrameSchema.safeParse(missing);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('authorizationRef'))).toBe(true);
    }
    const empty = { type: 'policy.update', policy: POLICY, direction: 'expand', authorizationRef: '' };
    expect(MechaDeviceFrameSchema.safeParse(empty).success).toBe(false);
  });

  it('policy.update direction=tighten 缺省 authorizationRef 允许(收紧立即生效不需要授权记录),带上也合法', () => {
    expect(
      MechaDeviceFrameSchema.safeParse({ type: 'policy.update', policy: POLICY, direction: 'tighten' })
        .success,
    ).toBe(true);
    expect(
      MechaDeviceFrameSchema.safeParse({
        type: 'policy.update',
        policy: POLICY,
        authorizationRef: 'auth-2',
        direction: 'tighten',
      }).success,
    ).toBe(true);
  });

  it('session.offer 内嵌 policy 走 MechaPolicySchema(dirs 相对路径连带拒绝)', () => {
    const badPolicy: Record<string, unknown> = { ...POLICY, dirs: ['Downloads'] };
    expect(
      MechaDeviceFrameSchema.safeParse({
        type: 'session.offer',
        sessionId: 'sess-1',
        orderRef: 'ord-1',
        driverAgentId: 'agent-driver-1',
        policy: badPolicy,
        expiresAt: '2026-10-17T00:05:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('session.manifest round-trip 保形(最小合法清单:sessionId/policy/mechaVersion/scratchDir)', () => {
    const frame = { type: 'session.manifest', sessionId: 'sess-m1', manifest: MANIFEST };
    const result = MechaDeviceFrameSchema.safeParse(frame);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(frame);
    }
  });

  it('session.manifest 缺 manifest / 缺 sessionId / manifest 形状非法(scratchDir 相对路径)拒绝', () => {
    // 缺 manifest
    expect(
      MechaDeviceFrameSchema.safeParse({ type: 'session.manifest', sessionId: 'sess-m1' }).success,
    ).toBe(false);
    // 缺 sessionId
    expect(MechaDeviceFrameSchema.safeParse({ type: 'session.manifest', manifest: MANIFEST }).success).toBe(
      false,
    );
    // manifest 内 scratchDir 相对路径 → 连带拒绝(走 CapabilityManifestSchema)
    const badManifest: Record<string, unknown> = {
      ...MANIFEST,
      scratchDir: '.clawrent/scratch/sess-m1',
    };
    expect(
      MechaDeviceFrameSchema.safeParse({
        type: 'session.manifest',
        sessionId: 'sess-m1',
        manifest: badManifest,
      }).success,
    ).toBe(false);
    // manifest 内 policy dirs 相对路径 → 连带拒绝
    const badDirsManifest: Record<string, unknown> = {
      ...MANIFEST,
      policy: { ...POLICY, dirs: ['Downloads'] },
    };
    expect(
      MechaDeviceFrameSchema.safeParse({
        type: 'session.manifest',
        sessionId: 'sess-m1',
        manifest: badDirsManifest,
      }).success,
    ).toBe(false);
  });
});

describe('mecha confirm request/result schemas', () => {
  it('合法请求解析通过(T1/T2 各一例,detail 可省略),round-trip 保形', () => {
    const t1: MechaConfirmRequest = {
      requestId: 'req-1',
      opId: 'op-1',
      tier: 'T1',
      summary: '要写入文件 out/report.csv',
    };
    const t1Parsed = MechaConfirmRequestSchema.safeParse(t1);
    expect(t1Parsed.success).toBe(true);
    if (t1Parsed.success) {
      expect(t1Parsed.data).toEqual(t1);
    }
    const t2: MechaConfirmRequest = {
      requestId: 'req-2',
      opId: 'op-2',
      tier: 'T2',
      summary: '要执行 node sort.py(工作目录 docs,超时 10 分钟)',
      detail: 'argv 直达进程不经 shell',
    };
    expect(MechaConfirmRequestSchema.safeParse(t2).success).toBe(true);
  });

  it('summary 空串 / 缺失拒绝;tier 枚举外拒绝(T0 免确认永不产生请求)', () => {
    const base: Record<string, unknown> = {
      requestId: 'req-1',
      opId: 'op-1',
      tier: 'T1',
      summary: '要删除目录 tmp',
    };
    const empty = { ...base, summary: '' };
    expect(MechaConfirmRequestSchema.safeParse(empty).success).toBe(false);
    const noSummary = { ...base };
    delete noSummary['summary'];
    expect(MechaConfirmRequestSchema.safeParse(noSummary).success).toBe(false);
    const t0 = { ...base, tier: 'T0' };
    expect(MechaConfirmRequestSchema.safeParse(t0).success).toBe(false);
  });

  it('合法结果解析通过(approved 带/不带 remember 两形),round-trip 保形,approved 非布尔拒绝', () => {
    const remembered: MechaConfirmResult = { requestId: 'req-1', approved: true, remember: true };
    expect(MechaConfirmResultSchema.safeParse(remembered).success).toBe(true);
    const denied: MechaConfirmResult = { requestId: 'req-2', approved: false };
    const deniedParsed = MechaConfirmResultSchema.safeParse(denied);
    expect(deniedParsed.success).toBe(true);
    if (deniedParsed.success) {
      expect(deniedParsed.data).toEqual(denied);
    }
    const badApproved = { requestId: 'req-1', approved: 'yes' };
    expect(MechaConfirmResultSchema.safeParse(badApproved).success).toBe(false);
  });
});
