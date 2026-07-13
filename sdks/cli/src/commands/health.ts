import { Command } from 'commander';
import { ApiClient, loadConfig } from '@clawrent/provider';
import { printJson, printError } from '../output.js';

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description('Check platform health')
    .action(async () => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.health();
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
