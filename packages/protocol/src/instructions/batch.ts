import { z } from 'zod';
import { ExecInstructionSchema } from './exec.js';
import { ReadFileInstructionSchema } from './read-file.js';
import { WriteFileInstructionSchema } from './write-file.js';
import { ReadDirInstructionSchema } from './read-dir.js';

const SingleInstructionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('instruction.exec'), payload: ExecInstructionSchema }),
  z.object({ type: z.literal('instruction.read_file'), payload: ReadFileInstructionSchema }),
  z.object({ type: z.literal('instruction.write_file'), payload: WriteFileInstructionSchema }),
  z.object({ type: z.literal('instruction.read_dir'), payload: ReadDirInstructionSchema }),
]);

export const BatchInstructionSchema = z.object({
  instructions: z.array(SingleInstructionSchema).min(1).max(50),
  execution: z.enum(['parallel', 'sequential']).default('sequential'),
  stopOnError: z.boolean().default(true),
});

export type BatchInstruction = z.infer<typeof BatchInstructionSchema>;
