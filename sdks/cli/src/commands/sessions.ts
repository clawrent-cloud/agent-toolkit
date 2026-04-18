import { Command } from 'commander';
import { loadConfig } from '../config.js';
import { ApiClient } from '../api-client.js';
import { printJson, printError } from '../output.js';

export function registerSessionsCommand(program: Command): void {
  program
    .command('sessions')
    .description('List your sessions')
    .option('-r, --role <role>', 'Filter by role (consumer/provider)')
    .option('-s, --status <status>', 'Filter by status')
    .option('-p, --page <number>', 'Page number', '1')
    .option('-l, --limit <number>', 'Results per page', '20')
    .action(async (opts: { role?: string; status?: string; page: string; limit: string }) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.getSessions({
          role: opts.role,
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
}
