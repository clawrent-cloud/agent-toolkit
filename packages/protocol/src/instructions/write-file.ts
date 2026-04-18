import { z } from 'zod';

export const WriteFileInstructionSchema = z.object({
  path: z.string().min(1),
  content: z.string().optional(),
  patch: z
    .object({
      type: z.enum(['line_replace', 'append', 'prepend', 'regex_replace']),
      target: z.string().optional(),
      replacement: z.string().optional(),
    })
    .optional(),
  createDirs: z.boolean().default(false),
  backup: z.boolean().default(true),
});

export type WriteFileInstruction = z.infer<typeof WriteFileInstructionSchema>;
