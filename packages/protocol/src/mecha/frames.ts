import { z } from 'zod';
import { CapabilityManifestSchema, MechaPolicySchema } from './policy.js';

/**
 * 机甲 v0 协议 —— 设备通道帧（device channel frames）。
 *
 * 机甲守护进程 ↔ 平台 同一条 WebSocket 上的全部控制帧，上行（设备 → 平台）与
 * 下行（平台 → 设备）共用一个 type 判别联合。下游消费者：session 状态机
 * （Task 12）、device client（Task 14）。
 *
 * schema 只做 wire 形状校验（与 policy.ts / ops.ts 同一裁定）：
 * - session.end.reason 六值 spec verbatim（MECHA_SESSION_END_REASONS 单一事实源）；
 * - policy.update 的「expand 必带 authorizationRef」是跨字段约束——Zod v3 的
 *   discriminatedUnion 成员只能是 ZodObject（ZodEffects 进不了 options），
 *   故落在联合级 superRefine 上；tighten 可缺省（收紧立即生效不需要授权记录）；
 * - 时间戳均为 JSON 序列化后的 ISO 字符串（staff 帧同款）；
 * - error.code / session.reject.reason v0 不钉枚举：op 级七码
 *   （MECHA_ERROR_CODES）只管 op 结果，通道级错误码/拒绝理由属平台侧后续契约。
 */

/** spec session.end.reason 全集（verbatim,单一事实源）。 */
export const MECHA_SESSION_END_REASONS = [
  'completed',
  'consumer_disconnect',
  'grace_expired',
  'balance_exhausted',
  'platform',
  'consumer_halt',
] as const;
export type MechaSessionEndReason = (typeof MECHA_SESSION_END_REASONS)[number];

/** policy.update 方向:expand = 放宽(必带授权记录),tighten = 收紧(可缺省)。 */
export const MECHA_POLICY_UPDATE_DIRECTIONS = ['expand', 'tighten'] as const;
export type MechaPolicyUpdateDirection = (typeof MECHA_POLICY_UPDATE_DIRECTIONS)[number];

// ── 上行帧（设备 → 平台）──────────────────────────────────────────────────

/** 设备 → 平台:连接问候。token = 设备令牌（T17 device flow 取得）——
 * optional 保持 additive 兼容（旧设备 / 不带鉴权的测试替身不发仍合法）。 */
const DeviceHelloFrameSchema = z.object({
  type: z.literal('device.hello'),
  deviceId: z.string(),
  mechaVersion: z.string(),
  token: z.string().min(1).optional(),
});

/** 设备 → 平台:心跳(间隔以 policy.limits.heartbeatMs 为准)。 */
const HeartbeatFrameSchema = z.object({ type: z.literal('heartbeat') });

/** 设备 → 平台:接受 offered 会话。 */
const SessionAcceptFrameSchema = z.object({
  type: z.literal('session.accept'),
  sessionId: z.string(),
});

/** 设备 → 平台:拒绝 offered 会话(reason 为人话,v0 不钉枚举)。 */
const SessionRejectFrameSchema = z.object({
  type: z.literal('session.reject'),
  reason: z.string(),
});

/** 设备 → 平台:attach 成功后上行本会话能力清单(CapabilityManifestSchema
 * 全量——平台侧存档归真 + 驾驶员可见的会话能力快照)。顶层 sessionId 与
 * manifest.sessionId 同值(顶层取 session.accept 同形,便于通道侧路由)。 */
const SessionManifestFrameSchema = z.object({
  type: z.literal('session.manifest'),
  sessionId: z.string(),
  manifest: CapabilityManifestSchema,
});

// ── 下行帧（平台 → 设备）──────────────────────────────────────────────────

/** 平台 → 设备:问候应答(serverTime 为 ISO 字符串,供设备校时)。 */
const DeviceWelcomeFrameSchema = z.object({
  type: z.literal('device.welcome'),
  serverTime: z.string(),
});

/** 平台 → 设备: offered 会话(expiresAt 为 ISO 字符串,过期未 accept 即回收)。 */
const SessionOfferFrameSchema = z.object({
  type: z.literal('session.offer'),
  sessionId: z.string(),
  orderRef: z.string(),
  driverAgentId: z.string(),
  policy: MechaPolicySchema,
  expiresAt: z.string(),
});

/** 平台 → 设备:暂停(驾驶员断开,grace 计时以 policy.limits.disconnectGraceMs 为准)。 */
const SessionPauseFrameSchema = z.object({ type: z.literal('session.pause') });

/** 平台 → 设备:恢复。 */
const SessionResumeFrameSchema = z.object({ type: z.literal('session.resume') });

/** 平台 → 设备:会话终局(reason 六值 spec verbatim)。 */
const SessionEndFrameSchema = z.object({
  type: z.literal('session.end'),
  reason: z.enum(MECHA_SESSION_END_REASONS),
});

/** 平台 → 设备:策略热更(expand 必带 authorizationRef——联合级 superRefine 钉死)。 */
const PolicyUpdateFrameSchema = z.object({
  type: z.literal('policy.update'),
  policy: MechaPolicySchema,
  direction: z.enum(MECHA_POLICY_UPDATE_DIRECTIONS),
  authorizationRef: z.string().min(1).optional(),
});

/** 平台 → 设备:心跳应答。 */
const HeartbeatAckFrameSchema = z.object({ type: z.literal('heartbeat_ack') });

/** 平台 → 设备:通道级错误(code v0 不钉枚举,message 为人话)。 */
const ErrorFrameSchema = z.object({
  type: z.literal('error'),
  code: z.string(),
  message: z.string(),
});

/**
 * 设备通道帧判别联合(discriminant = type,上行 + 下行同通道)。
 * 联合级 superRefine:policy.update 且 direction='expand' 时 authorizationRef
 * 必填(非空串)——放宽执行边界必须可追溯到授权记录;缺省时 issue 落在
 * authorizationRef 路径上。
 */
export const MechaDeviceFrameSchema = z
  .discriminatedUnion('type', [
    DeviceHelloFrameSchema,
    HeartbeatFrameSchema,
    SessionAcceptFrameSchema,
    SessionRejectFrameSchema,
    SessionManifestFrameSchema,
    DeviceWelcomeFrameSchema,
    SessionOfferFrameSchema,
    SessionPauseFrameSchema,
    SessionResumeFrameSchema,
    SessionEndFrameSchema,
    PolicyUpdateFrameSchema,
    HeartbeatAckFrameSchema,
    ErrorFrameSchema,
  ])
  .superRefine((frame, ctx) => {
    if (
      frame.type === 'policy.update' &&
      frame.direction === 'expand' &&
      frame.authorizationRef === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authorizationRef'],
        message: "authorizationRef is required when direction is 'expand'",
      });
    }
  });
export type MechaDeviceFrame = z.infer<typeof MechaDeviceFrameSchema>;
