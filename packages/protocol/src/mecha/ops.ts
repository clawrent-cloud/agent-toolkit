import { z } from 'zod';

/**
 * 机甲 v0 协议 —— 驾驶原语（structured op）帧。
 *
 * 驾驶员（消费者 agent）对机甲的一切操作都是结构化 op：fs.* 文件原语 +
 * exec.run 执行原语 + file.upload 暂存区通道（spec §5.1 原语表）。
 * schema 只做 wire 形状校验：路径字符串的白名单解析归 path-guard（Task 10
 * resolveWithinWhitelist），exec argv 的程序白名单/溯源判级归 computeTier
 * （Task 6）——分层拒绝，本文件不越权做语义校验。
 *
 * tier 语义：结果帧只在 T1/T2（经确认制）时带 tier；T0 免确认 op 不带。
 * 下游消费者：executor（Task 10/11）、MechaDriver（Task 21）。
 */

/** spec §5.1/§5.4 错误码全集（单一事实源，机甲拒答/失败只允许这七种）。 */
export const MECHA_ERROR_CODES = [
  'PATH_DENIED',
  'PROGRAM_DENIED',
  'CONFIRM_DENIED',
  'CONFIRM_TIMEOUT',
  'EXEC_TIMEOUT',
  'SIZE_LIMIT',
  'IO_ERROR',
] as const;
export type MechaErrorCode = (typeof MECHA_ERROR_CODES)[number];

/** 失败结果 error 对象（code + 人话 message）。 */
const MechaErrorSchema = z.object({
  code: z.enum(MECHA_ERROR_CODES),
  message: z.string(),
});

// ── 驾驶原语（按 type 判别的联合）──────────────────────────────────────────

/** fs.list:列目录（白名单内读,T0 免确认）。depth 非负整数(0=仅本层)。 */
const FsListOpSchema = z.object({
  type: z.literal('fs.list'),
  path: z.string(),
  depth: z.number().int().nonnegative().optional(),
  glob: z.string().optional(),
});

/** fs.read:读文件(≤maxFileBytes/次,T0);内容经平台中继,base64 供二进制。 */
const FsReadOpSchema = z.object({
  type: z.literal('fs.read'),
  path: z.string(),
  encoding: z.enum(['utf8', 'base64']),
});

/** fs.write:写/覆盖文件,产出交付物(T1,入溯源表)。 */
const FsWriteOpSchema = z.object({
  type: z.literal('fs.write'),
  path: z.string(),
  content: z.string(),
  encoding: z.enum(['utf8', 'base64']),
});

/** fs.mkdir:建目录(T1)。 */
const FsMkdirOpSchema = z.object({
  type: z.literal('fs.mkdir'),
  path: z.string(),
});

/** fs.move:移动(T1)。 */
const FsMoveOpSchema = z.object({
  type: z.literal('fs.move'),
  from: z.string(),
  to: z.string(),
});

/** fs.copy:复制(T1)。 */
const FsCopyOpSchema = z.object({
  type: z.literal('fs.copy'),
  from: z.string(),
  to: z.string(),
});

/** fs.delete:删除(recursive 控制递归,T1)。 */
const FsDeleteOpSchema = z.object({
  type: z.literal('fs.delete'),
  path: z.string(),
  recursive: z.boolean(),
});

/** file.upload:驾驶员工具/脚本的唯一写入通道——只落会话暂存区,入溯源表(T1)。 */
const FileUploadOpSchema = z.object({
  type: z.literal('file.upload'),
  name: z.string(),
  content: z.string(),
});

/** exec.run:argv 数组直达进程不经 shell(无管道/替换/转义逃逸面);argv 至少 1 项且每项非空串(T1/T2 由判级决定)。 */
const ExecRunOpSchema = z.object({
  type: z.literal('exec.run'),
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string(),
  timeoutMs: z.number().int().positive().optional(),
  env: z.record(z.string()).optional(),
});

/** 驾驶原语判别联合(discriminant = type)。 */
export const MechaOpSchema = z.discriminatedUnion('type', [
  FsListOpSchema,
  FsReadOpSchema,
  FsWriteOpSchema,
  FsMkdirOpSchema,
  FsMoveOpSchema,
  FsCopyOpSchema,
  FsDeleteOpSchema,
  FileUploadOpSchema,
  ExecRunOpSchema,
]);
export type MechaOp = z.infer<typeof MechaOpSchema>;

// ── 信封 / 结果 / exec 流块 ────────────────────────────────────────────────

/** op 信封:opId 由驾驶员生成用于关联结果与流块,sessionId 绑定会话。 */
export const MechaOpEnvelopeSchema = z.object({
  opId: z.string(),
  sessionId: z.string(),
  op: MechaOpSchema,
});
export type MechaOpEnvelope = z.infer<typeof MechaOpEnvelopeSchema>;

/** op 结果:T0 免确认不带 tier;T1/T2 结果带 tier 供审计;失败走 error(七码)。 */
export const MechaOpResultSchema = z.object({
  opId: z.string(),
  ok: z.boolean(),
  tier: z.enum(['T1', 'T2']).optional(),
  value: z.unknown().optional(),
  error: MechaErrorSchema.optional(),
});
export type MechaOpResult = z.infer<typeof MechaOpResultSchema>;

/** exec.run 流式回传块(stdout/stderr),seq 单调递增用于排序与断流检测。 */
export const MechaExecChunkSchema = z.object({
  opId: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  data: z.string(),
  seq: z.number().int().nonnegative(),
});
export type MechaExecChunk = z.infer<typeof MechaExecChunkSchema>;
