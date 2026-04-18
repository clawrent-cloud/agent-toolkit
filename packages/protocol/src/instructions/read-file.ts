import { z } from 'zod';

export const ReadFileInstructionSchema = z.object({
  path: z.string().min(1),
  encoding: z.string().default('utf-8'),
  lineRange: z
    .object({
      start: z.number().nonnegative(),
      end: z.number().positive(),
    })
    .optional(),
  purpose: z.string().optional(),
});

export type ReadFileInstruction = z.infer<typeof ReadFileInstructionSchema>;
