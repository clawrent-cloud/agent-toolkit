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
 * LIMITS 数值以 MECHA_LIMITS_DEFAULTS 为单一事实源（spec §11 verbatim）；
 * schema 只做形状校验（正整数）——policy 由平台下发（session.offer / policy.update），
 * 平台侧调参不应使 wire 帧过不了 schema；设备侧执行口径以常量为准。
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

/** 会话限额:形状校验(正整数);数值口径以 MECHA_LIMITS_DEFAULTS(spec §11)为准。 */
export const MechaLimitsSchema = z.object({
  confirmTimeoutMs: z.number().int().positive(),
  disconnectGraceMs: z.number().int().positive(),
  heartbeatMs: z.number().int().positive(),
  maxFileBytes: z.number().int().positive(),
  execTimeoutDefaultMs: z.number().int().positive(),
  execTimeoutMaxMs: z.number().int().positive(),
  maxConcurrentExecs: z.number().int().positive(),
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
