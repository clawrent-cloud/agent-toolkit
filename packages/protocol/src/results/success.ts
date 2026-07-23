import { z } from 'zod';

export const SuccessResultSchema = z.object({
  instructionId: z.string(),
  data: z.object({
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    exitCode: z.number().optional(),
    content: z.string().optional(),
    fileList: z
      .array(
        z.object({
          name: z.string(),
          path: z.string(),
          isDirectory: z.boolean(),
          size: z.number().optional(),
          modifiedAt: z.string().optional(),
        }),
      )
      .optional(),
  }),
  executionTime: z.number(),
  /** Plan 4: provider agent 的 token 用量(plugin/ProviderClient 填,Plan 4b)。
   *  缺省(undefined)→ 不累加(向后兼容现有 plugin)。对齐主仓
   *  clawrent/packages/protocol/src/results/success.ts。 */
  usage: z.object({ totalTokens: z.number().min(0).optional() }).optional(),
});

export type SuccessResult = z.infer<typeof SuccessResultSchema>;
