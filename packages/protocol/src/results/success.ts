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
});

export type SuccessResult = z.infer<typeof SuccessResultSchema>;
