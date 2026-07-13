import { readFileSync, writeFileSync, unlinkSync, openSync, closeSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { getConfigDir } from '@clawrent/provider';

export function getPidFilePath(agentId: string): string {
  return join(getConfigDir(), `serve-${agentId}.pid`);
}

export function getLogFilePath(agentId: string): string {
  return join(getConfigDir(), `serve-${agentId}.log`);
}

export function readPid(agentId: string): number | null {
  try {
    const content = readFileSync(getPidFilePath(agentId), 'utf-8').trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

export function writePid(agentId: string, pid: number): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(getPidFilePath(agentId), String(pid), 'utf-8');
}

export function removePidFile(agentId: string): void {
  try {
    unlinkSync(getPidFilePath(agentId));
  } catch {
    // Ignore ENOENT
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonRunning(agentId: string): { running: boolean; pid: number | null } {
  const pid = readPid(agentId);
  if (pid === null) return { running: false, pid: null };

  if (isProcessAlive(pid)) {
    return { running: true, pid };
  }

  // Stale PID file — process is dead, clean up
  removePidFile(agentId);
  return { running: false, pid: null };
}

/** List all running daemons by scanning PID files in config dir */
export function listRunningDaemons(): Array<{ agentId: string; pid: number }> {
  const dir = getConfigDir();
  if (!existsSync(dir)) return [];

  const results: Array<{ agentId: string; pid: number }> = [];

  for (const file of readdirSync(dir)) {
    const match = /^serve-(.+)\.pid$/.exec(basename(file));
    if (!match) continue;

    const agentId = match[1]!;
    const { running, pid } = isDaemonRunning(agentId);
    if (running && pid !== null) {
      results.push({ agentId, pid });
    }
  }

  return results;
}

export function spawnDaemon(agentId: string, args: string[]): number {
  const logFile = getLogFilePath(agentId);
  const dir = getConfigDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const logFd = openSync(logFile, 'a');

  const child = spawn(process.argv[0]!, [process.argv[1]!, ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
  });

  child.unref();
  closeSync(logFd);

  if (!child.pid) {
    throw new Error('Failed to start daemon process');
  }

  return child.pid;
}
