import { z } from 'zod';

export const SessionControlSchema = z.object({
  action: z.enum(['init', 'ready', 'pause', 'resume', 'complete', 'abort', 'checkpoint']),
  reason: z.string().optional(),
  checkpoint: z.record(z.unknown()).optional(),
});

export type SessionControl = z.infer<typeof SessionControlSchema>;
