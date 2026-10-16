import { z } from 'zod';

/**
 * 机甲 v0 协议 —— 确认帧（human-in-the-loop confirm）。
 *
 * T1/T2 判级 op（ops.ts 域；T0 免确认永不产生本组帧）执行前需驾驶员批准：
 * 请求侧 summary 为人话描述（非空串，展示给驾驶员/其用户），detail 可选补充；
 * 结果侧 approved 决定放行，remember 供会话内记忆本裁决（v0 只透传布尔，
 * 语义归消费层）。requestId 双向关联请求与结果。
 * 下游消费者：session 状态机（Task 12）、device client（Task 14）。
 */

/** 确认请求:tier 只允许 T1/T2(经确认制)。 */
export const MechaConfirmRequestSchema = z.object({
  requestId: z.string(),
  opId: z.string(),
  tier: z.enum(['T1', 'T2']),
  summary: z.string().min(1),
  detail: z.string().optional(),
});
export type MechaConfirmRequest = z.infer<typeof MechaConfirmRequestSchema>;

/** 确认结果:approved 放行与否;remember? 可选记忆本裁决。 */
export const MechaConfirmResultSchema = z.object({
  requestId: z.string(),
  approved: z.boolean(),
  remember: z.boolean().optional(),
});
export type MechaConfirmResult = z.infer<typeof MechaConfirmResultSchema>;
