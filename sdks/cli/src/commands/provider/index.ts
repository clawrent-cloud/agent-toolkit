import { Command } from 'commander';
import { ApiClient, loadConfig } from '@clawrent/provider';
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
    .description('Register a new agent (consumer by default)')
    .requiredOption('--name <name>', 'Agent name')
    .requiredOption('--slug <slug>', 'Agent slug (URL-friendly)')
    .requiredOption('--description <desc>', 'Agent description (10-500 chars)')
    .option('--long-description <text>', 'Detailed description')
    .option('--capabilities <json>', 'Capabilities as JSON array')
    .option('--permissions <json>', 'Required permissions as JSON array')
    .action(async (opts: {
      name: string; slug: string; description: string; longDescription?: string;
      capabilities?: string; permissions?: string;
    }) => {
      try {
        const data: Record<string, unknown> = {
          name: opts.name,
          slug: opts.slug,
          description: opts.description,
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
        if (opts.permissions) {
          try {
            data['requiredPermissions'] = JSON.parse(opts.permissions);
          } catch {
            printError('Invalid JSON for --permissions');
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
    .option('-r, --roles <roles>', 'Filter by roles (consumer, both)')
    .option('-p, --page <number>', 'Page number', '1')
    .option('-l, --limit <number>', 'Results per page', '20')
    .action(async (opts: { roles?: string; page: string; limit: string }) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.getMyAgents({
          roles: opts.roles,
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
    .command('apply-provider <agentId>')
    .description('Apply for provider role on an agent')
    .option('--pricing-model <model>', 'Pricing model (per_token/per_session/per_minute)', 'per_session')
    .option('--price <amount>', 'Price amount', '1.00')
    .option('--currency <cur>', 'Currency (CNY/USD)', 'CNY')
    .option('--hosting-type <type>', 'Hosting type (self_hosted/platform_hosted)', 'self_hosted')
    .option('--approval-mode <mode>', 'Session approval mode (manual/auto)', 'manual')
    .option('--max-concurrent <n>', 'Max concurrent sessions', '5')
    .option('--max-slots <n>', 'Max consumer slots per session', '1')
    .action(async (agentId: string, opts: {
      pricingModel: string; price: string; currency: string; hostingType: string;
      approvalMode: string; maxConcurrent: string; maxSlots: string;
    }) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.applyProvider(agentId, {
          pricingModel: opts.pricingModel,
          priceAmount: opts.price,
          currency: opts.currency,
          hostingType: opts.hostingType,
          approvalMode: opts.approvalMode,
          maxConcurrentSessions: parseInt(opts.maxConcurrent, 10),
          maxConsumerSlots: parseInt(opts.maxSlots, 10),
        });
        printSuccess('Provider application submitted.');
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
