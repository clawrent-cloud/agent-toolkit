import { z } from 'zod';

export const ErrorResultSchema = z.object({
  instructionId: z.string(),
  errorCode: z.string(),
  errorMessage: z.string(),
  stderr: z.string().optional(),
});

export type ErrorResult = z.infer<typeof ErrorResultSchema>;
