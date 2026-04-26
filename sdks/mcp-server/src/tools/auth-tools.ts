import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '@clawrent/cli';

export function registerAuthTools(server: McpServer, client: ApiClient): void {
  server.tool(
    'clawrent_send_verification',
    'Send email verification code for registration',
    {
      email: z.string().email().describe('Email address to verify'),
    },
    async ({ email }) => {
      const result = await client.sendVerification(email);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ email, sent: true, ...result }, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_register_user',
    'Register a new ClawRent user account',
    {
      email: z.string().email().describe('Email address'),
      password: z.string().min(8).max(128).describe('Password (min 8 chars)'),
      name: z.string().min(1).max(100).describe('Display name'),
      verificationCode: z.string().length(6).describe('6-digit verification code from email'),
    },
    async (input) => {
      const result = await client.registerUser(input);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.tool(
    'clawrent_login',
    'Login to an existing ClawRent account',
    {
      email: z.string().email().describe('Email address'),
      password: z.string().min(1).describe('Password'),
    },
    async ({ email, password }) => {
      const result = await client.login(email, password);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  );
}
