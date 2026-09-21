import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ApiClient } from '@clawrent/provider';

// Shared wrapper for every staff tool: staff tools stay registered (discoverable)
// even without CLAWRENT_STAFF_TOKEN, but each call first requires one — without it
// the handler returns an isError result instead of hitting the API. API errors are
// caught and surfaced as isError results too.
async function staffCall(client: ApiClient, action: () => Promise<unknown>): Promise<CallToolResult> {
  if (!client.hasStaffToken()) {
    return {
      content: [{
        type: 'text',
        text: 'Error: CLAWRENT_STAFF_TOKEN not configured. Set the CLAWRENT_STAFF_TOKEN environment variable to use staff tools (X-Staff-Token auth).',
      }],
      isError: true,
    };
  }
  try {
    const result = await action();
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: JSON.stringify(message) }],
      isError: true,
    };
  }
}

export function registerStaffTools(server: McpServer, client: ApiClient): void {
  server.tool(
    'clawrent_staff_whoami',
    'Identify the current staff identity. Returns the staff user resolved from CLAWRENT_STAFF_TOKEN (X-Staff-Token auth). Use this first to verify the token is valid and see what staff scope you have.',
    {},
    async () => staffCall(client, () => client.staffWhoami()),
  );

  server.tool(
    'clawrent_staff_get_tasks',
    'List tasks in the staff inbox: tasks assigned to the staff identity that are awaiting acknowledgement, a result proposal, or an error report.',
    {},
    async () => staffCall(client, () => client.staffGetTasks()),
  );

  server.tool(
    'clawrent_staff_ack_task',
    'Acknowledge (claim) a staff task so the platform records that this staff identity has picked it up. Call after clawrent_staff_get_tasks before working on it.',
    {
      taskId: z.string().describe('Staff task ID to acknowledge'),
    },
    async ({ taskId }) => staffCall(client, () => client.staffAckTask(taskId)),
  );

  server.tool(
    'clawrent_staff_submit_result',
    'Submits a result which becomes a proposal requiring human approval — it never executes directly. Use this to deliver the completed work for a staff task: proposedAction is the work product, reasoning explains to the human approver why it is correct.',
    {
      taskId: z.string().describe('Staff task ID to submit the result for'),
      proposedAction: z.string().describe('The proposed action / work product, reviewed by a human before anything executes'),
      reasoning: z.string().describe('Explanation shown to the human approver alongside the proposed action'),
    },
    async ({ taskId, proposedAction, reasoning }) =>
      staffCall(client, () => client.staffSubmitResult(taskId, { proposedAction, reasoning })),
  );

  server.tool(
    'clawrent_staff_task_error',
    'Report that a staff task could not be completed, with a human-readable reason. Use instead of clawrent_staff_submit_result when the task failed or cannot be fulfilled.',
    {
      taskId: z.string().describe('Staff task ID to report the error for'),
      message: z.string().describe('Human-readable description of what went wrong'),
    },
    async ({ taskId, message }) => staffCall(client, () => client.staffTaskError(taskId, message)),
  );

  server.tool(
    'clawrent_staff_query',
    'Run a read-only staff query against platform data (no mutations). Pick queryType from the whitelist and pass any needed parameters.',
    {
      queryType: z
        .enum(['user.view', 'agent.view', 'session.view', 'audit.view'])
        .describe('Query type whitelist: user.view, agent.view, session.view, audit.view'),
      parameters: z
        .record(z.unknown())
        .optional()
        .describe('Optional parameters object passed through to the query (e.g. {"userId": "..."} or {"sessionId": "..."})'),
    },
    async ({ queryType, parameters }) =>
      staffCall(client, () => client.staffQuery(queryType, parameters)),
  );
}
