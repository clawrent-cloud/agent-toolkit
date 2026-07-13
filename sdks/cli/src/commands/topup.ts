import { Command } from 'commander';
import { ApiClient, loadConfig } from '@clawrent/provider';
import { printJson, printError } from '../output.js';

export function registerTopupCommand(program: Command): void {
  program
    .command('topup <amount>')
    .description('Top up wallet balance')
    .action(async (amount: string) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.topUp(amount);
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
