import { z } from 'zod';

/**
 * Staff 帧协议 —— /ws/staff 通道（Platform ↔ Agent Staff）。
 *
 * 契约源 = 主仓 apps/platform-api/src/ws/ws-staff-handler.ts 的实现（本地 Zod schema），
 * 0.4.0 破坏性替换旧 HCP 形状（staff.task_assign / action_proposal / action_approved /
 * action_rejected 等从未在平台落地的设计稿 schema，已删除）。
 * 0.5.0: StaffTaskPayload +responseLanguage?(平台请求的对内反馈语言)
 *
 * 出站（平台 → staff）：staff.hello / staff.tasks_snapshot / staff.task / staff.query_response
 * 入站（staff → 平台）：staff.task_ack / staff.task_result / staff.task_error / staff.query
 */

// ── 出站帧（平台 → staff）─────────────────────────────────────────────────

/** 平台 → staff:连接建立问候。grants = 连接生效权限(stf 全量 / dlg = humanGrants ∩ scope)。 */
export const StaffHelloFrameSchema = z.object({
  type: z.literal('staff.hello'),
  staffId: z.string(),
  displayName: z.string(),
  department: z.string(),
  grants: z.array(z.object({ actionId: z.string(), autonomy: z.enum(['advisory', 'autonomous']) })),
  delegation: z.object({ id: z.string(), label: z.string() }).optional(),
});
export type StaffHelloFrame = z.infer<typeof StaffHelloFrameSchema>;

/** 任务载荷(派发帧与快照共用;createdAt/expiresAt 为 JSON 序列化后的 ISO 字符串)。 */
export const StaffTaskPayloadSchema = z.object({
  id: z.string(),
  actionId: z.string(),
  source: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  params: z.record(z.unknown()),
  retryCount: z.number().int(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  // 平台请求的反馈语言(BCP-47 tag,如 zh-CN):reasoning 请按此语言产出;advisory 不强制校验。
  // 0.5.0 additive——旧消费者(strip)与旧 payload(无字段)双向兼容。
  responseLanguage: z.string().optional(),
});
export type StaffTaskPayload = z.infer<typeof StaffTaskPayloadSchema>;

/** 平台 → staff:任务派发帧(dispatchPendingTasks notify 的 frame shape)。 */
export const StaffTaskDispatchFrameSchema = z.object({
  type: z.literal('staff.task'),
  task: StaffTaskPayloadSchema,
});
export type StaffTaskDispatchFrame = z.infer<typeof StaffTaskDispatchFrameSchema>;

/** 平台 → staff:连接建立时的该 staff 名下 pending 任务快照。 */
export const StaffTasksSnapshotFrameSchema = z.object({
  type: z.literal('staff.tasks_snapshot'),
  tasks: z.array(StaffTaskPayloadSchema),
});
export type StaffTasksSnapshotFrame = z.infer<typeof StaffTasksSnapshotFrameSchema>;

// ── 入站帧（staff → 平台）─────────────────────────────────────────────────

export const StaffTaskAckFrameSchema = z.object({
  type: z.literal('staff.task_ack'),
  taskId: z.string(),
});
export type StaffTaskAckFrame = z.infer<typeof StaffTaskAckFrameSchema>;

/**
 * staff.task_result 入站帧:proposedAction + reasoning 必填(端点契约 —— 结果即提案;
 * 失败走 staff.task_error,不接受 status 字段)。
 */
export const StaffTaskResultFrameSchema = z.object({
  type: z.literal('staff.task_result'),
  taskId: z.string(),
  reasoning: z.string(),
  proposedAction: z.object({
    targetType: z.string(),
    targetId: z.string(),
    params: z.record(z.unknown()),
  }),
});
export type StaffTaskResultFrame = z.infer<typeof StaffTaskResultFrameSchema>;

export const StaffTaskErrorFrameSchema = z.object({
  type: z.literal('staff.task_error'),
  taskId: z.string(),
  message: z.string(),
});
export type StaffTaskErrorFrame = z.infer<typeof StaffTaskErrorFrameSchema>;

export const StaffQueryFrameSchema = z.object({
  type: z.literal('staff.query'),
  queryId: z.string(),
  queryType: z.string(),
  parameters: z.record(z.unknown()).optional(),
});
export type StaffQueryFrame = z.infer<typeof StaffQueryFrameSchema>;

/** 平台 → staff:查询应答(data 与 error 二选一)。 */
export const StaffQueryResponseFrameSchema = z.object({
  type: z.literal('staff.query_response'),
  queryId: z.string(),
  data: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});
export type StaffQueryResponseFrame = z.infer<typeof StaffQueryResponseFrameSchema>;

// ── 方向联合 ─────────────────────────────────────────────────────────────

/** 入站联合(staff → 平台):task_ack / task_result / task_error / query。 */
export const StaffInboundFrameSchema = z.discriminatedUnion('type', [
  StaffTaskAckFrameSchema,
  StaffTaskResultFrameSchema,
  StaffTaskErrorFrameSchema,
  StaffQueryFrameSchema,
]);
export type StaffInboundFrame = z.infer<typeof StaffInboundFrameSchema>;

/** 出站联合(平台 → staff):hello / tasks_snapshot / task / query_response。 */
export const StaffOutboundFrameSchema = z.discriminatedUnion('type', [
  StaffHelloFrameSchema,
  StaffTasksSnapshotFrameSchema,
  StaffTaskDispatchFrameSchema,
  StaffQueryResponseFrameSchema,
]);
export type StaffOutboundFrame = z.infer<typeof StaffOutboundFrameSchema>;
