import { z } from 'zod';

export const ExecInstructionSchema = z.object({
  command: z.string().min(1),
  workingDir: z.string().optional(),
  timeout: z.number().positive().default(30000),
  env: z.record(z.string()).optional(),
  expect: z
    .object({
      exitCode: z.number().optional(),
      stdoutContains: z.string().optional(),
    })
    .optional(),
  onFailure: z.enum(['abort', 'continue', 'retry']).default('abort'),
  explanation: z.string().optional(),
  riskLevel: z.enum(['low', 'medium', 'high']).default('medium'),
});

export type ExecInstruction = z.infer<typeof ExecInstructionSchema>;
