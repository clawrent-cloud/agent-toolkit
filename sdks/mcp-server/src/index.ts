import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ApiClient, loadConfig } from '@clawrent/cli';
import { ProviderAgent } from './provider-agent.js';
import { registerConsumerTools } from './tools/consumer-tools.js';
import { registerProviderTools } from './tools/provider-tools.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const client = new ApiClient(config);

  // In-process provider agent (shared singleton across all provider tools)
  const providerAgent = new ProviderAgent(client);

  const server = new McpServer({
    name: 'clawrent',
    version: '0.1.0',
  });

  // Register all tools
  registerConsumerTools(server, client);
  registerProviderTools(server, client, providerAgent);

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
