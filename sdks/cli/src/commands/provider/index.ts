import { Command } from 'commander';
import { loadConfig } from '../../config.js';
import { ApiClient } from '../../api-client.js';
import { printJson, printError, printSuccess } from '../../output.js';

export function registerProviderCommands(program: Command): void {
  const provider = program
    .command('provider')
    .description('Provider operations');

  // --- Agent subcommands ---
  const agent = provider
    .command('agent')
    .description('Manage your agents');

  agent
    .command('create')
    .description('Register a new agent')
    .requiredOption('--name <name>', 'Agent name')
    .requiredOption('--slug <slug>', 'Agent slug (URL-friendly)')
    .requiredOption('--description <desc>', 'Agent description (10-500 chars)')
    .option('--long-description <text>', 'Detailed description')
    .option('--pricing-model <model>', 'Pricing model (per_token/per_session/per_minute)', 'per_session')
    .option('--price <amount>', 'Price amount', '1.00')
    .option('--currency <cur>', 'Currency (CNY/USD)', 'CNY')
    .option('--hosting-type <type>', 'Hosting type (self_hosted/platform_hosted)', 'self_hosted')
    .option('--approval-mode <mode>', 'Approval mode (manual/auto)', 'manual')
    .option('--max-concurrent <n>', 'Max concurrent sessions', '5')
    .option('--capabilities <json>', 'Capabilities as JSON array')
    .action(async (opts: {
      name: string; slug: string; description: string; longDescription?: string;
      pricingModel: string; price: string; currency: string; hostingType: string;
      approvalMode: string; maxConcurrent: string; capabilities?: string;
    }) => {
      try {
        const data: Record<string, unknown> = {
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
          pricingModel: opts.pricingModel,
          priceAmount: opts.price,
          currency: opts.currency,
          hostingType: opts.hostingType,
          approvalMode: opts.approvalMode,
          maxConcurrentSessions: parseInt(opts.maxConcurrent, 10),
        };
        if (opts.longDescription) data['longDescription'] = opts.longDescription;
        if (opts.capabilities) {
          try {
            data['capabilities'] = JSON.parse(opts.capabilities);
          } catch {
            printError('Invalid JSON for --capabilities');
            process.exit(1);
          }
        }

        const client = new ApiClient(loadConfig());
        const result = await client.registerAgent(data);
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  agent
    .command('list')
    .description('List your agents')
    .option('-s, --status <status>', 'Filter by status')
    .option('-p, --page <number>', 'Page number', '1')
    .option('-l, --limit <number>', 'Results per page', '20')
    .action(async (opts: { status?: string; page: string; limit: string }) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.getMyAgents({
          status: opts.status,
          page: parseInt(opts.page, 10),
          limit: parseInt(opts.limit, 10),
        });
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  agent
    .command('publish <agentId>')
    .description('Publish an agent (draft -> pending_review)')
    .action(async (agentId: string) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.publishAgent(agentId);
        printSuccess('Agent published successfully.');
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  agent
    .command('activate <agentId>')
    .description('Activate an agent (pending_review -> active)')
    .action(async (agentId: string) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.activateAgent(agentId);
        printSuccess('Agent activated successfully.');
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  agent
    .command('status <agentId>')
    .description('Set agent online status')
    .requiredOption('--status <status>', 'Online status (online/offline/busy)')
    .action(async (agentId: string, opts: { status: string }) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.setOnlineStatus(agentId, opts.status);
        printSuccess(`Agent status set to ${opts.status}.`);
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  // --- Provider session commands ---
  provider
    .command('sessions')
    .description('List provider sessions')
    .option('-s, --status <status>', 'Filter by status')
    .option('-p, --page <number>', 'Page number', '1')
    .option('-l, --limit <number>', 'Results per page', '20')
    .action(async (opts: { status?: string; page: string; limit: string }) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.getSessions({
          role: 'provider',
          status: opts.status,
          page: parseInt(opts.page, 10),
          limit: parseInt(opts.limit, 10),
        });
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  provider
    .command('approve <sessionId>')
    .description('Approve a pending session')
    .action(async (sessionId: string) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.approveSession(sessionId);
        printSuccess('Session approved.');
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
