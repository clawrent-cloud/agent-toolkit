import { z } from 'zod';
import { isAbsolute, win32 } from 'node:path';

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

/**
 * 绝对路径校验(纯验证,不做任何 fs/realpath——那是强制层的事)。
 * 双平台口径（0.6.2）：POSIX 绝对或 win32 绝对（盘符 `D:\Docs`/`D:/Docs` + UNC
 * `\\server\share`）——schema 在两端跑（平台策略校验在 Linux 容器、设备强制层
 * 在本机），单按宿主 `path.isAbsolute` 会把 Windows 设备的真实白名单在平台侧
 * 全数拒掉（e2e-mecha 2026-10-24 发现）。
 */
const AbsolutePathSchema = z
  .string()
  .refine((p) => isAbsolute(p) || win32.isAbsolute(p), { message: 'must be an absolute path' });

/** argv 策略（L2 程序条目级，2026-11-21 hardening 增补）：平台下发、机甲本地
 * 强制；全部 optional——缺省=现状。语义红线：forbiddenSubcommands/
 * requiredFlags 只收紧；appendFlags 为平台/消费者侧主动选择（如 npm
 * `--ignore-scripts`；D3 裁定默认不注入，仅显式下发生效）。 */
export const MechaArgvPolicySchema = z.object({
  /** executor 在 spawn 前追加到 argv 尾部的旗标（仅平台显式下发才注入）。 */
  appendFlags: z.array(z.string()).optional(),
  /** 子命令 token 在 argv 任意位置精确命中任一 → T2（全 token 扫描：取值
   * 全局旗标藏不住子命令；值参数与禁词同名的误红属宁误红方向）。 */
  forbiddenSubcommands: z.array(z.string()).optional(),
  /** argv 缺任一必附旗标 → T2。在场口径：整 token，或 `flag=value` 形且值
   * 非关闭式（''/'0'/'false' 不算在场——`--x=false` 对消必附旗标 = 缺席）。 */
  requiredFlags: z.array(z.string()).optional(),
});
export type MechaArgvPolicy = z.infer<typeof MechaArgvPolicySchema>;

/** env 策略（L2）：op.env 出现 allowedKeys 清单外键 → T2（win32 键名大小写
 * 不敏感，与 EXEC_ENV_DENYLIST 同口径）。 */
export const MechaEnvPolicySchema = z.object({
  allowedKeys: z.array(z.string()).optional(),
});
export type MechaEnvPolicy = z.infer<typeof MechaEnvPolicySchema>;

/** 程序白名单条目:裸名 → 钉死的登记真身绝对路径(永不文件系统搜索)。
 * L2 策略字段（tier/argvPolicy/envPolicy）全部 optional：旧平台裸条目照常
 * （缺省全走现状）；新字段条目在旧机甲侧被 zod strip → 降级为现状（optional
 * 起步的兼容语义，双端任一端旧版本均不破）。 */
export const MechaProgramEntrySchema = z.object({
  name: z.string(),
  absPath: AbsolutePathSchema,
  /** 平台声明该程序一律 T2（只收紧的声明位；唯一合法值 'T2'）。 */
  tier: z.literal('T2').optional(),
  argvPolicy: MechaArgvPolicySchema.optional(),
  envPolicy: MechaEnvPolicySchema.optional(),
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
