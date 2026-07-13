import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '@clawrent/provider';

export function registerConsumerTools(server: McpServer, client: ApiClient): void {
  // --- Marketplace ---

  server.tool(
    'clawrent_browse',
    'Browse available agents on the ClawRent marketplace',
    {
      search: z.string().optional().describe('Search agents by name'),
      category: z.string().optional().describe('Filter by category'),
      page: z.number().optional().describe('Page number (default: 1)'),
      limit: z.number().optional().describe('Results per page (default: 20)'),
    },
    async ({ search, category, page, limit }) => {
      const result = await client.browse({ search, category, page, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_agent_details',
    'Get detailed information about a specific agent by its slug',
    {
      slug: z.string().describe('Agent slug (URL-friendly identifier)'),
    },
    async ({ slug }) => {
      const result = await client.getAgent(slug);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- Sessions ---

  server.tool(
    'clawrent_rent_agent',
    'Rent an agent by creating a new session. Returns session details including sessionId and sessionToken.',
    {
      agentId: z.string().describe('ID of the agent to rent'),
      taskDescription: z.string().describe('Description of the task (10-2000 chars)'),
      permissions: z.string().optional().describe('Granted permissions as JSON string (default: {})'),
    },
    async ({ agentId, taskDescription, permissions }) => {
      let grantedPermissions: Record<string, unknown> = {};
      if (permissions) {
        try {
          grantedPermissions = JSON.parse(permissions) as Record<string, unknown>;
        } catch {
          return {
            content: [{ type: 'text' as const, text: 'Error: Invalid JSON for permissions' }],
            isError: true,
          };
        }
      }
      const result = await client.rent({ agentId, taskDescription, grantedPermissions });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_list_sessions',
    'List your sessions on the platform',
    {
      role: z.string().optional().describe('Filter by role: consumer or provider'),
      status: z.string().optional().describe('Filter by status (e.g., active, completed, pending_approval)'),
      page: z.number().optional().describe('Page number'),
      limit: z.number().optional().describe('Results per page'),
    },
    async ({ role, status, page, limit }) => {
      const result = await client.getSessions({ role, status, page, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_end_session',
    'End an active session. Triggers billing settlement.',
    {
      sessionId: z.string().describe('ID of the session to end'),
    },
    async ({ sessionId }) => {
      const result = await client.endSession(sessionId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_session_messages',
    'Get message history for a session',
    {
      sessionId: z.string().describe('Session ID'),
    },
    async ({ sessionId }) => {
      const result = await client.getSessionMessages(sessionId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- Billing ---

  server.tool(
    'clawrent_check_balance',
    'Check your wallet balance on the ClawRent platform',
    {},
    async () => {
      const result = await client.getBalance();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_topup',
    'Top up your wallet balance',
    {
      amount: z.string().describe('Amount to top up (e.g., "100.00")'),
    },
    async ({ amount }) => {
      const result = await client.topUp(amount);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- Orders ---

  server.tool(
    'clawrent_create_order',
    'Create an order to rent one or more agents. Each item creates an associated session. Optionally checkout from cart.',
    {
      items: z.string().describe('JSON array of order items: [{"providerAgentId":"...","taskDescription":"...","consumerAgentId":"..."}]'),
      note: z.string().optional().describe('Order note'),
      fromCart: z.boolean().optional().describe('If true, clear cart after order creation'),
    },
    async ({ items, note, fromCart }) => {
      let parsedItems: Array<{ providerAgentId: string; consumerAgentId?: string; taskDescription: string }>;
      try {
        parsedItems = JSON.parse(items) as typeof parsedItems;
      } catch {
        return {
          content: [{ type: 'text' as const, text: 'Error: Invalid JSON for items array' }],
          isError: true,
        };
      }
      const result = await client.createOrder({ items: parsedItems, note, fromCart });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_list_orders',
    'List your orders',
    {
      status: z.string().optional().describe('Filter by status (pending, active, completed, cancelled)'),
      page: z.number().optional().describe('Page number'),
      limit: z.number().optional().describe('Results per page'),
    },
    async ({ status, page, limit }) => {
      const result = await client.getOrders({ status, page, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_order_detail',
    'Get detailed information about a specific order including its items',
    {
      orderId: z.string().describe('Order ID'),
    },
    async ({ orderId }) => {
      const result = await client.getOrder(orderId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_cancel_order',
    'Cancel an order. Only pending/active orders can be cancelled.',
    {
      orderId: z.string().describe('Order ID'),
    },
    async ({ orderId }) => {
      const result = await client.cancelOrder(orderId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- Cart ---

  server.tool(
    'clawrent_list_cart',
    'View your shopping cart items',
    {},
    async () => {
      const result = await client.getCart();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_add_to_cart',
    'Add an agent to your shopping cart',
    {
      providerAgentId: z.string().describe('Agent ID to add'),
      taskDescription: z.string().describe('Task description for the agent (10-2000 chars)'),
    },
    async ({ providerAgentId, taskDescription }) => {
      const result = await client.addToCart({ providerAgentId, taskDescription });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_remove_from_cart',
    'Remove a specific item from the shopping cart',
    {
      itemId: z.string().describe('Cart item ID to remove'),
    },
    async ({ itemId }) => {
      const result = await client.removeFromCart(itemId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_clear_cart',
    'Clear all items from the shopping cart',
    {},
    async () => {
      const result = await client.clearCart();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  // --- Favorites ---

  server.tool(
    'clawrent_add_favorite',
    'Add an agent to your favorites',
    {
      agentId: z.string().describe('Agent ID to favorite'),
    },
    async ({ agentId }) => {
      const result = await client.addFavorite(agentId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_remove_favorite',
    'Remove an agent from your favorites',
    {
      agentId: z.string().describe('Agent ID to unfavorite'),
    },
    async ({ agentId }) => {
      const result = await client.removeFavorite(agentId);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_list_favorites',
    'List your favorited agents',
    {
      page: z.number().optional().describe('Page number'),
      limit: z.number().optional().describe('Results per page'),
    },
    async ({ page, limit }) => {
      const result = await client.listFavorites({ page, limit });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
