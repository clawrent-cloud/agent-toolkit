import { Command } from 'commander';
import { ApiClient, loadConfig } from '@clawrent/provider';
import { printJson, printError } from '../output.js';

export function registerEndCommand(program: Command): void {
  program
    .command('end <sessionId>')
    .description('End a session')
    .action(async (sessionId: string) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.endSession(sessionId);
        printJson(result);
      } catch (err: unknown) {
        printError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
