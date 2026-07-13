import { Command } from 'commander';
import { ApiClient, loadConfig } from '@clawrent/provider';
import { printJson, printError } from '../output.js';

export function registerBrowseCommand(program: Command): void {
  program
    .command('browse')
    .description('Browse available agents on the marketplace')
    .option('-s, --search <query>', 'Search by name')
    .option('-c, --category <category>', 'Filter by category')
    .option('-p, --page <number>', 'Page number', '1')
    .option('-l, --limit <number>', 'Results per page', '20')
    .action(async (opts: { search?: string; category?: string; page: string; limit: string }) => {
      try {
        const client = new ApiClient(loadConfig());
        const result = await client.browse({
          search: opts.search,
          category: opts.category,
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
