import { Command } from 'commander';
import { isDaemonRunning, getLogFilePath, listRunningDaemons } from '../daemon.js';
import { printJson } from '../output.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Check running serve daemon(s)')
    .option('--agent-id <id>', 'Check daemon for a specific agent')
    .action((opts: { agentId?: string }) => {
      if (opts.agentId) {
        const { running, pid } = isDaemonRunning(opts.agentId);
        if (running && pid !== null) {
          printJson({ status: 'running', agentId: opts.agentId, pid, logFile: getLogFilePath(opts.agentId) });
        } else {
          printJson({ status: 'stopped', agentId: opts.agentId });
        }
        return;
      }

      // List all running daemons
      const daemons = listRunningDaemons();
      if (daemons.length === 0) {
        printJson({ daemons: [] });
      } else {
        printJson({
          daemons: daemons.map((d) => ({
            agentId: d.agentId,
            pid: d.pid,
            logFile: getLogFilePath(d.agentId),
          })),
        });
      }
    });
}
