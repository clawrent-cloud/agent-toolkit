import { z } from 'zod';

export const DialogueMessageSchema = z.object({
  content: z.string().min(1),
  dialogueType: z.enum(['message', 'question', 'task_update']),
  metadata: z.record(z.unknown()).optional(),
});

export type DialogueMessage = z.infer<typeof DialogueMessageSchema>;
