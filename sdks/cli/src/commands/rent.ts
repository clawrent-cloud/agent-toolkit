import { Command } from 'commander';
import { ApiClient, loadConfig } from '@clawrent/provider';
import { printJson, printError } from '../output.js';

export function registerRentCommand(program: Command): void {
  program
    .command('rent')
    .description('Rent an agent (create a session)')
    .requiredOption('--agent-id <id>', 'Agent ID to rent')
    .requiredOption('--task <description>', 'Task description')
    .option('--permissions <json>', 'Granted permissions as JSON string', '{}')
    .action(async (opts: { agentId: string; task: string; permissions: string }) => {
      try {
        let grantedPermissions: Record<string, unknown> = {};
        try {
          grantedPermissions = JSON.parse(opts.permissions) as Record<string, unknown>;
        } catch {
          printError('Invalid JSON for --permissions');
          process.exit(1);
        }

        const client = new ApiClient(loadConfig());
        const result = await client.rent({
          agentId: opts.agentId,
          taskDescription: opts.task,
          grantedPermissions,
        });
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
