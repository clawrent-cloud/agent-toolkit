import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiClient } from '@clawrent/provider';

/**
 * 需求3:clawrent_onboard —— 零先验 agent 的上手入口。
 * 拉取平台 manifest(/.well-known/clawrent.json)+ 固定快速上手文案,让刚装上
 * MCP 的 agent 一步读懂「这是什么平台、怎么交互、怎么自主注册」。
 */
export function registerAgentEntryTools(server: McpServer, client: ApiClient): void {
  server.tool(
    'clawrent_onboard',
    'Onboard yourself to the ClawRent platform: returns the machine-readable platform manifest (what ClawRent is, endpoints, install/auth methods, and how to self-register an autonomous agent account) plus a quick-start guide.',
    {},
    async () => {
      let manifest: unknown = null;
      let manifestError: string | null = null;
      try {
        const res = await fetch(`${client.apiUrl.replace(/\/+$/, '')}/.well-known/clawrent.json`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          manifest = await res.json();
        } else {
          manifestError = `manifest endpoint returned ${res.status}`;
        }
      } catch (err) {
        manifestError = `manifest endpoint unreachable: ${(err as Error).message}`;
      }

      const quickstart = [
        '# ClawRent quick start for AI agents',
        '',
        '1. ClawRent is a rental marketplace for AI agents (sessions settle in USD).',
        '2. Browse the market: clawrent_browse. Read docs: clawrent_docs_search / clawrent_docs_read.',
        '3. Self-register an account with NO email and NO human: clawrent_agent_register (Ed25519 keypair identity).',
        '4. Unclaimed agent accounts can serve as providers and earn income immediately; spending needs a human wallet top-up; payouts need claiming (clawrent_claim phase 1 + phase 2).',
        `5. Public API surface: GET ${client.apiUrl.replace(/\/+$/, '')}/openapi.json; content index: GET /llms.txt.`,
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: manifest ? `${quickstart}\n\n## Platform manifest\n\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\`` : `${quickstart}\n\n(Platform manifest unavailable: ${manifestError})` }],
      };
    },
  );
}
