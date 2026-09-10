import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApiClient, loadConfig } from '@clawrent/provider';
import { ProviderAgent } from './provider-agent.js';
import { registerAuthTools } from './tools/auth-tools.js';
import { registerConsumerTools } from './tools/consumer-tools.js';
import { registerProviderTools } from './tools/provider-tools.js';
import { registerDocsTools } from './tools/docs-tools.js';

// Advertise the package's own version (read at runtime from package.json, same
// pattern as the CLI) instead of a hardcoded string that drifts on every bump.
const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_VERSION = (
  JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as { version: string }
).version;

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ApiClient(config);

  // Provider mode via env: if CLAWRENT_AGENT_TOKEN is set, use it for all REST
  // calls (approve/list/end/balance) without needing clawrent_start_serving.
  // start_serving's agentToken parameter still overrides this at runtime.
  const agentTokenEnv = process.env['CLAWRENT_AGENT_TOKEN'];
  if (agentTokenEnv) {
    client.setAgentToken(agentTokenEnv);
  }

  // In-process provider agent (shared singleton across all provider tools)
  const providerAgent = new ProviderAgent(client);

  const server = new McpServer({
    name: 'clawrent',
    version: PACKAGE_VERSION,
  });

  // Register all tools
  registerAuthTools(server, client);
  registerConsumerTools(server, client);
  registerProviderTools(server, client, providerAgent);
  registerDocsTools(server, client);

  // Forward incoming consumer messages (from WS) as MCP logging notifications, so
  // the host UI can surface them in real time. Some clients treat these as logs
  // and don't feed them to the LLM — for authoritative history, poll
  // clawrent_get_session_messages with a `since` cursor.
  providerAgent.on('session:message', (sessionId: string, message: Record<string, unknown>) => {
    void server.sendLoggingMessage({
      level: 'info',
      logger: `session:${sessionId}`,
      data: message,
    });
  });

  // Cleanup on exit
  process.on('SIGINT', () => {
    providerAgent.stop();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    providerAgent.stop();
    process.exit(0);
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`MCP Server error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
