import { z } from 'zod';
import { isAbsolute } from 'node:path';

/**
 * 机甲 v0 协议 —— 策略与能力清单（capability manifest）。
 *
 * 会话 token 携带的 MechaPolicy（目录白名单 + 程序白名单 + 限额）由平台下发、
 * 机甲守护进程本地强制执行；CapabilityManifest 是机甲 attach 成功后回执给
 * 驾驶员的「本会话能做什么」清单。schema 形状即 spec §5/§11 的协议契约，
 * 后续 mecha.* 帧族（ops/confirm/frames）与本文件同风格扩展。
 *
 * LIMITS 按 spec §11 verbatim 钉死：单一事实源 = MECHA_LIMITS_DEFAULTS，
 * schema 用 z.literal 引用该常量（不散落字面量、wire 上拒绝偏离值）。
 */

/** spec §11 默认限额（verbatim,单一事实源）。 */
export const MECHA_LIMITS_DEFAULTS = {
  confirmTimeoutMs: 300_000,
  disconnectGraceMs: 60_000,
  heartbeatMs: 30_000,
  maxFileBytes: 20_971_520,
  execTimeoutDefaultMs: 600_000,
  execTimeoutMaxMs: 1_800_000,
  maxConcurrentExecs: 1,
} as const;

/** 绝对路径校验(纯验证,不做任何 fs/realpath——那是强制层的事)。 */
const AbsolutePathSchema = z
  .string()
  .refine((p) => isAbsolute(p), { message: 'must be an absolute path' });

/** 程序白名单条目:裸名 → 钉死的登记真身绝对路径(永不文件系统搜索)。 */
export const MechaProgramEntrySchema = z.object({
  name: z.string(),
  absPath: AbsolutePathSchema,
});
export type MechaProgramEntry = z.infer<typeof MechaProgramEntrySchema>;

/** 会话限额(spec §11,值以 literal 钉死)。 */
export const MechaLimitsSchema = z.object({
  confirmTimeoutMs: z.literal(MECHA_LIMITS_DEFAULTS.confirmTimeoutMs),
  disconnectGraceMs: z.literal(MECHA_LIMITS_DEFAULTS.disconnectGraceMs),
  heartbeatMs: z.literal(MECHA_LIMITS_DEFAULTS.heartbeatMs),
  maxFileBytes: z.literal(MECHA_LIMITS_DEFAULTS.maxFileBytes),
  execTimeoutDefaultMs: z.literal(MECHA_LIMITS_DEFAULTS.execTimeoutDefaultMs),
  execTimeoutMaxMs: z.literal(MECHA_LIMITS_DEFAULTS.execTimeoutMaxMs),
  maxConcurrentExecs: z.literal(MECHA_LIMITS_DEFAULTS.maxConcurrentExecs),
});
export type MechaLimits = z.infer<typeof MechaLimitsSchema>;

/** 会话策略:目录白名单 + 程序白名单 + 限额。 */
export const MechaPolicySchema = z.object({
  dirs: z.array(AbsolutePathSchema),
  programs: z.array(MechaProgramEntrySchema),
  limits: MechaLimitsSchema,
});
export type MechaPolicy = z.infer<typeof MechaPolicySchema>;

/** 能力清单:机甲 attach 成功后回执给驾驶员的本会话能力快照。 */
export const CapabilityManifestSchema = z.object({
  sessionId: z.string(),
  policy: MechaPolicySchema,
  mechaVersion: z.string(),
  scratchDir: AbsolutePathSchema,
});
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
