import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '@clawrent/cli';
import type { ProviderAgent } from '../provider-agent.js';

export function registerProviderTools(server: McpServer, client: ApiClient, providerAgent: ProviderAgent): void {
  server.tool(
    'clawrent_register_agent',
    'Register a new agent on the ClawRent platform',
    {
      name: z.string().describe('Agent name (1-100 chars)'),
      slug: z.string().describe('URL-friendly slug (lowercase, hyphens)'),
      description: z.string().describe('Agent description (10-500 chars)'),
      longDescription: z.string().optional().describe('Detailed description (max 5000 chars)'),
      pricingModel: z.enum(['per_token', 'per_session', 'per_minute']).optional().describe('Pricing model (default: per_session)'),
      priceAmount: z.string().optional().describe('Price amount (default: 1.00)'),
      currency: z.enum(['CNY', 'USD']).optional().describe('Currency (default: CNY)'),
      hostingType: z.enum(['self_hosted', 'platform_hosted']).optional().describe('Hosting type (default: self_hosted)'),
      approvalMode: z.enum(['manual', 'auto']).optional().describe('Session approval mode (default: manual)'),
      maxConcurrentSessions: z.number().optional().describe('Max concurrent sessions (default: 5)'),
    },
    async (params) => {
      const data: Record<string, unknown> = {
        name: params.name,
        slug: params.slug,
        description: params.description,
      };
      if (params.longDescription) data['longDescription'] = params.longDescription;
      if (params.pricingModel) data['pricingModel'] = params.pricingModel;
      if (params.priceAmount) data['priceAmount'] = params.priceAmount;
      if (params.currency) data['currency'] = params.currency;
      if (params.hostingType) data['hostingType'] = params.hostingType;
      if (params.approvalMode) data['approvalMode'] = params.approvalMode;
      if (params.maxConcurrentSessions) data['maxConcurrentSessions'] = params.maxConcurrentSessions;

      const result = await client.registerAgent(data);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_publish_agent',
    'Publish an agent (changes status from draft to pending_review)',
    {
      agentId: z.string().describe('Agent ID'),
    },
    async ({ agentId }) => {
      const result = await client.publishAgent(agentId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_activate_agent',
    'Activate an agent (changes status from pending_review to active). Requires agent token and active WS connection.',
    {
      agentId: z.string().describe('Agent ID'),
    },
    async ({ agentId }) => {
      const result = await client.activateAgent(agentId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_set_agent_status',
    'Set agent online status (online, offline, or busy)',
    {
      agentId: z.string().describe('Agent ID'),
      onlineStatus: z.enum(['online', 'offline', 'busy']).describe('Target online status'),
    },
    async ({ agentId, onlineStatus }) => {
      const result = await client.setOnlineStatus(agentId, onlineStatus);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_list_my_agents',
    'List agents owned by the current user',
    {
      status: z.string().optional().describe('Filter by status (draft, pending_review, active, suspended)'),
      page: z.number().optional().describe('Page number'),
      limit: z.number().optional().describe('Results per page'),
    },
    async ({ status, page, limit }) => {
      const result = await client.getMyAgents({ status, page, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_approve_session',
    'Approve a pending session request',
    {
      sessionId: z.string().describe('Session ID to approve'),
    },
    async ({ sessionId }) => {
      const result = await client.approveSession(sessionId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- Token Management ---

  server.tool(
    'clawrent_generate_agent_token',
    'Generate or regenerate an agent token for WebSocket authentication. The token is shown only once.',
    {
      agentId: z.string().describe('Agent ID'),
    },
    async ({ agentId }) => {
      const result = await client.generateAgentToken(agentId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_revoke_agent_token',
    'Revoke an agent token. The agent will be disconnected and cannot reconnect until a new token is generated.',
    {
      agentId: z.string().describe('Agent ID'),
    },
    async ({ agentId }) => {
      const result = await client.revokeAgentToken(agentId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- In-process Serve ---

  server.tool(
    'clawrent_start_serving',
    'Start serving as a provider agent. Connects to the platform via WebSocket in-process (no subprocess). Listens for incoming session requests and auto-approves them if enabled.',
    {
      agentId: z.string().describe('Agent ID to serve'),
      agentToken: z.string().describe('Agent token for WebSocket authentication'),
      autoApprove: z.boolean().optional().describe('Automatically approve incoming sessions (default: true)'),
    },
    async ({ agentId, agentToken, autoApprove }) => {
      if (providerAgent.running) {
        return {
          content: [{ type: 'text' as const, text: `Already serving agent ${providerAgent.currentAgentId}. Stop it first with clawrent_stop_serving.` }],
          isError: true,
        };
      }

      try {
        await providerAgent.start(agentId, agentToken, autoApprove ?? true);
        return {
          content: [{
            type: 'text' as const,
            text: `Agent ${agentId} is now serving in-process.\nAuto-approve: ${autoApprove ?? true}\nWaiting for incoming sessions via /ws/agent channel.`,
          }],
        };
      } catch (err: unknown) {
        return {
          content: [{ type: 'text' as const, text: `Failed to start serving: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'clawrent_stop_serving',
    'Stop the in-process provider agent. Disconnects all sessions and the agent control channel.',
    {},
    async () => {
      if (!providerAgent.running) {
        return {
          content: [{ type: 'text' as const, text: 'No agent is currently serving.' }],
        };
      }

      const agentId = providerAgent.currentAgentId;
      providerAgent.stop();
      return {
        content: [{ type: 'text' as const, text: `Agent ${agentId} stopped serving.` }],
      };
    },
  );

  server.tool(
    'clawrent_send_session_message',
    'Send a message to an active session as the provider agent. Requires clawrent_start_serving to be active.',
    {
      sessionId: z.string().describe('Session ID'),
      type: z.string().optional().describe('Message type (default: result.success)'),
      payload: z.string().describe('Message payload as JSON string'),
    },
    async ({ sessionId, type, payload }) => {
      if (!providerAgent.running) {
        return {
          content: [{ type: 'text' as const, text: 'No agent is currently serving. Start with clawrent_start_serving first.' }],
          isError: true,
        };
      }

      let parsedPayload: Record<string, unknown>;
      try {
        parsedPayload = JSON.parse(payload) as Record<string, unknown>;
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Error: Invalid JSON for payload' }],
          isError: true,
        };
      }

      const sent = providerAgent.send(sessionId, {
        type: type ?? 'result.success',
        payload: parsedPayload,
      });

      if (!sent) {
        return {
          content: [{ type: 'text' as const, text: `Session ${sessionId} is not connected or not found.` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Message sent to session ${sessionId}.` }],
      };
    },
  );

  server.tool(
    'clawrent_serving_status',
    'Check the current serving status: whether an agent is active, which sessions are connected.',
    {},
    async () => {
      if (!providerAgent.running) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ serving: false }, null, 2) }],
        };
      }

      const sessions = providerAgent.getSessions();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            serving: true,
            agentId: providerAgent.currentAgentId,
            activeSessions: sessions.length,
            sessions: sessions.map(s => ({
              sessionId: s.sessionId,
              taskDescription: s.taskDescription,
              consumerUserId: s.consumerUserId,
            })),
          }, null, 2),
        }],
      };
    },
  );
}
