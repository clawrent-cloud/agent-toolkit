import { z } from 'zod';

/**
 * Staff Task Assignment — Platform → Agent Staff
 * Assigns an operational task to an agent staff member via HCP session.
 */
export const StaffTaskAssignSchema = z.object({
  taskId: z.string(),
  actionId: z.string(),
  department: z.string(),
  description: z.string(),
  targetType: z.string().optional(),
  targetId: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  deadline: z.number().optional(),
});
export type StaffTaskAssign = z.infer<typeof StaffTaskAssignSchema>;

/**
 * Staff Task Result — Agent Staff → Platform
 * Returns the result of a completed staff task.
 */
export const StaffTaskResultSchema = z.object({
  taskId: z.string(),
  actionId: z.string(),
  status: z.enum(['completed', 'failed', 'needs_review']),
  result: z.record(z.unknown()).optional(),
  reasoning: z.string().optional(),
  proposedAction: z
    .object({
      targetType: z.string(),
      targetId: z.string(),
      params: z.record(z.unknown()),
    })
    .optional(),
});
export type StaffTaskResult = z.infer<typeof StaffTaskResultSchema>;

/**
 * Staff Query — Platform → Agent Staff
 * Platform asks agent staff for data analysis, recommendations, etc.
 */
export const StaffQuerySchema = z.object({
  queryId: z.string(),
  queryType: z.string(),
  parameters: z.record(z.unknown()).optional(),
});
export type StaffQuery = z.infer<typeof StaffQuerySchema>;

/**
 * Staff Query Response — Agent Staff → Platform
 * Agent staff responds with analysis results.
 */
export const StaffQueryResponseSchema = z.object({
  queryId: z.string(),
  data: z.record(z.unknown()),
  summary: z.string().optional(),
});
export type StaffQueryResponse = z.infer<typeof StaffQueryResponseSchema>;

/**
 * Staff Action Proposal — Agent Staff → Platform
 * Agent staff proposes an action for human approval.
 */
export const StaffActionProposalSchema = z.object({
  proposalId: z.string().optional(),
  actionId: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  params: z.record(z.unknown()),
  reasoning: z.string(),
  urgency: z.enum(['low', 'medium', 'high']).optional(),
});
export type StaffActionProposal = z.infer<typeof StaffActionProposalSchema>;

/**
 * Staff Action Approved/Rejected — Platform → Agent Staff
 * Notifies agent staff of proposal outcome.
 */
export const StaffActionOutcomeSchema = z.object({
  proposalId: z.string(),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().optional(),
});
export type StaffActionOutcome = z.infer<typeof StaffActionOutcomeSchema>;
