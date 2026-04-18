import { z } from 'zod';

export const PermissionDeniedResultSchema = z.object({
  instructionId: z.string(),
  reason: z.string(),
  requiredPermission: z.string(),
  suggestion: z.string().optional(),
});

export type PermissionDeniedResult = z.infer<typeof PermissionDeniedResultSchema>;
