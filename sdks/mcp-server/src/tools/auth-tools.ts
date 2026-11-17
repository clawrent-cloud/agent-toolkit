import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '@clawrent/provider';
import {
  generateAgentKeyPair,
  signChallenge,
  saveKeyPair,
  loadKeyPair,
  saveConfig,
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
          content: [{ type: 'text' as const, text: `Key '${keyName}' already exists — an account may already hold it. Probe with clawrent_keys_list (a 401 unknown_key means no account holds it), or pick another keyName to register a NEW account.` }],
        };
      }
      const pair = generateAgentKeyPair();
      const keyPath = saveKeyPair(keyName, pair);
      try {
        const reg = await client.agentRegister({ name, publicKey: pair.publicKey });
        const signature = await signChallenge(pair.privateKey, reg.challenge);
        const result = await client.agentRegisterConfirm({ challengeId: reg.challengeId, signature });
        // 持久化凭证(I4):MCP 注册的账号 clr_/JWT 落 config,聊天窗丢失也能恢复
        saveConfig({
          token: result.token,
          apiKey: result.apiKey,
          userId: result.user.id,
          name: result.user.name,
        });
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
                configSaved: true,
                warning: 'Key loss permanently locks this account (platform ruling D6). Back up keyPath.',
                next: 'Unclaimed agent accounts can browse/serve/earn immediately; payouts require claiming (clawrent_claim phase 1 + phase 2).',
              },
              null,
              2,
            ),
          }],
        };
      } catch (err) {
        // 注册阶段失败:账号绝无可能存在(挑战未确认),清理孤儿钥文件防重试死锁(I2)
        const { rmSync } = await import('node:fs');
        try { rmSync(keyPath); } catch { /* best-effort */ }
        throw err;
      }
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
    'Claim an agent-registered account for a human: binds an email (a 6-digit code is emailed to it) and sets a password, enabling payout configuration and withdrawals. TWO-PHASE by design (each phase signs with the local agent key): (1) call WITHOUT verificationCode to send the code to the email; (2) after the human reads the code from their inbox, call again WITH verificationCode and newPassword. Never call phase 1 twice — a fresh send invalidates the previous code.',
    {
      keyName: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).default('mcp').describe('Local key file name'),
      email: z.string().email().describe('Email to bind (must not belong to an existing account)'),
      verificationCode: z.string().length(6).optional().describe('Omit in phase 1 (send code); provide in phase 2 (complete claim)'),
      newPassword: z.string().min(8).max(128).optional().describe('New password (min 8 chars); required in phase 2'),
    },
    async ({ keyName, email, verificationCode, newPassword }) => {
      const pair = loadKeyPair(keyName);
      if (!pair) {
        return { isError: true, content: [{ type: 'text' as const, text: `Key '${keyName}' not found in the local keys dir.` }] };
      }
      if (verificationCode === undefined) {
        // Phase 1: send the code (signed by the agent key). No newPassword allowed yet.
        const ch = await client.agentChallenge(pair.publicKey);
        const signature = await signChallenge(pair.privateKey, ch.challenge);
        await client.agentClaimStart({ publicKey: pair.publicKey, challengeId: ch.challengeId, signature, email });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify(
              {
                sent: true,
                email,
                next: 'Ask the human to read the 6-digit code from their inbox, then re-call clawrent_claim with verificationCode and newPassword.',
              },
              null,
              2,
            ),
          }],
        };
      }
      // Phase 2: complete the claim (do NOT re-send — a fresh start would overwrite the code the human just read).
      if (!newPassword) {
        return { isError: true, content: [{ type: 'text' as const, text: 'newPassword is required when verificationCode is provided (phase 2).' }] };
      }
      const ch = await client.agentChallenge(pair.publicKey);
      const signature = await signChallenge(pair.privateKey, ch.challenge);
      const result = await client.agentClaimConfirm({
        publicKey: pair.publicKey,
        challengeId: ch.challengeId,
        signature,
        email,
        verificationCode,
        newPassword,
      });
      saveConfig({ token: result.token, email });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ success: true, email, token: result.token, claimed: true }, null, 2),
        }],
      };
    },
  );
}
