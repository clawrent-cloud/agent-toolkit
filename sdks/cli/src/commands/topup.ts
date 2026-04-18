import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { ApiClient } from '../api-client.js';
import { printSuccess, printError } from '../output.js';

export function registerTopupCommand(program: Command): void {
  program
    .command('topup <amount>')
    .description('Top up wallet balance')
    .action(async (amount: string) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.topUp(amount);
        printSuccess(`New balance: ${result.balance}`);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
