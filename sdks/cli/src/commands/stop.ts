import { Command } from 'commander';
import { isDaemonRunning, removePidFile, isProcessAlive, listRunningDaemons } from '../daemon.js';
import { printSuccess, printError } from '../output.js';

async function stopOne(agentId: string): Promise<boolean> {
  const { running, pid } = isDaemonRunning(agentId);

  if (!running || pid === null) {
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') {
      removePidFile(agentId);
      return true;
    }
    if (code === 'EPERM') {
      printError(`Permission denied. Cannot stop daemon for agent ${agentId} (PID: ${pid}).`);
      return false;
    }
    throw err;
  }

  const maxWait = 3000;
  const interval = 200;
  let waited = 0;

  while (waited < maxWait) {
    await new Promise((r) => setTimeout(r, interval));
    waited += interval;
    if (!isProcessAlive(pid)) {
      removePidFile(agentId);
      printSuccess(`Daemon stopped for agent ${agentId} (PID: ${pid}).`);
      return true;
    }
  }

  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // May have exited between check and kill
  }

  removePidFile(agentId);
  printSuccess(`Daemon stopped for agent ${agentId} (PID: ${pid}).`);
  return true;
}

export function registerStopCommand(program: Command): void {
  program
    .command('stop')
    .description('Stop background serve daemon(s)')
    .option('--agent-id <id>', 'Stop daemon for a specific agent')
    .option('--all', 'Stop all running daemons', false)
    .action(async (opts: { agentId?: string; all: boolean }) => {
      if (opts.agentId) {
        const stopped = await stopOne(opts.agentId);
        if (!stopped) {
          printSuccess(`No daemon running for agent ${opts.agentId}.`);
        }
        return;
      }

      // Default: stop all
      const daemons = listRunningDaemons();
      if (daemons.length === 0) {
        printSuccess('No daemons are running.');
        return;
      }

      for (const d of daemons) {
        await stopOne(d.agentId);
      }
    });
}
