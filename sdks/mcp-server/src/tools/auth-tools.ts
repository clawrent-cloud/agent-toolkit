import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '@clawrent/provider';
import {
  generateAgentKeyPair,
  signChallenge,
  saveKeyPair,
  loadKeyPair,
} from '@clawrent/provider';

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

  // ── 需求1:Agent 自主注册与钥管理(无邮箱/无人工) ──

  server.tool(
    'clawrent_agent_register',
    'Register a ClawRent account AS AN AUTONOMOUS AGENT: generates an Ed25519 keypair (stored in the local keys dir), registers via challenge-signature, and returns account credentials. No email, no human. Losing the key locks the account permanently — persist the returned key path.',
    {
      name: z.string().min(1).max(100).describe('Display name for the agent account'),
      keyName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('mcp').describe('Local key file name (default "mcp")'),
    },
    async ({ name, keyName }) => {
      if (loadKeyPair(keyName)) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `Key '${keyName}' already exists — the platform rejects re-registering the same public key. Use clawrent_keys_list/add on the existing account.` }],
        };
      }
      const pair = generateAgentKeyPair();
      const keyPath = saveKeyPair(keyName, pair);
      const reg = await client.agentRegister({ name, publicKey: pair.publicKey });
      const signature = await signChallenge(pair.privateKey, reg.challenge);
      const result = await client.agentRegisterConfirm({ challengeId: reg.challengeId, signature });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              user: result.user,
              apiKey: result.apiKey,
              token: result.token,
              keyPath,
              warning: 'Key loss permanently locks this account (platform ruling D6). Back up keyPath.',
              next: 'Unclaimed agent accounts can browse/serve/earn immediately; payouts require claiming (clawrent_claim with the human email flow).',
            },
            null,
            2,
          ),
        }],
      };
    },
  );

  server.tool(
    'clawrent_keys_list',
    'List the principal keys of the agent account bound to a local Ed25519 key',
    {
      keyName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('mcp').describe('Local key file name'),
    },
    async ({ keyName }) => {
      const pair = loadKeyPair(keyName);
      if (!pair) {
        return { isError: true, content: [{ type: 'text' as const, text: `Key '${keyName}' not found in the local keys dir.` }] };
      }
      const ch = await client.agentChallenge(pair.publicKey);
      const signature = await signChallenge(pair.privateKey, ch.challenge);
      const result = await client.agentKeysList({ publicKey: pair.publicKey, challengeId: ch.challengeId, signature });
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.tool(
    'clawrent_claim',
    'Claim an agent-registered account for a human: binds an email (verification code is emailed) and sets a password. Enables payout configuration and withdrawals. The local agent key signs the claim.',
    {
      keyName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('mcp').describe('Local key file name'),
      email: z.string().email().describe('Email to bind (must not belong to an existing account)'),
      verificationCode: z.string().length(6).describe('6-digit code emailed to the address'),
      newPassword: z.string().min(8).max(128).describe('New password for the account (min 8 chars)'),
    },
    async ({ keyName, email, verificationCode, newPassword }) => {
      const pair = loadKeyPair(keyName);
      if (!pair) {
        return { isError: true, content: [{ type: 'text' as const, text: `Key '${keyName}' not found in the local keys dir.` }] };
      }
      const ch = await client.agentChallenge(pair.publicKey);
      const startSig = await signChallenge(pair.privateKey, ch.challenge);
      await client.agentClaimStart({ publicKey: pair.publicKey, challengeId: ch.challengeId, signature: startSig, email });
      const ch2 = await client.agentChallenge(pair.publicKey);
      const confirmSig = await signChallenge(pair.privateKey, ch2.challenge);
      const result = await client.agentClaimConfirm({
        publicKey: pair.publicKey,
        challengeId: ch2.challengeId,
        signature: confirmSig,
        email,
        verificationCode,
        newPassword,
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, email, token: result.token, claimed: true }, null, 2),
        }],
      };
    },
  );
}
