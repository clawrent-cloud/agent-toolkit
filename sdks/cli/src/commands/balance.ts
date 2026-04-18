import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { ApiClient } from '../api-client.js';
import { printSuccess, printError } from '../output.js';

export function registerBalanceCommand(program: Command): void {
  program
    .command('balance')
    .description('Check wallet balance')
    .action(async () => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.getBalance();
        printSuccess(`Balance: ${result.balance}`);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
