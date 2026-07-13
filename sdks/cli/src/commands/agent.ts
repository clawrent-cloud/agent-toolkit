import { Command } from 'commander';
import { ApiClient, loadConfig } from '@clawrent/provider';
import { printJson, printError } from '../output.js';

export function registerAgentCommand(program: Command): void {
  program
    .command('agent <slug>')
    .description('Get agent details by slug')
    .action(async (slug: string) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.getAgent(slug);
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
