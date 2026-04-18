import { z } from 'zod';

export const ReadDirInstructionSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().default(false),
  pattern: z.string().optional(),
});

export type ReadDirInstruction = z.infer<typeof ReadDirInstructionSchema>;
