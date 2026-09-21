import { spawn } from 'node:child_process';
import { StaffAgentClient } from '@clawrent/provider';
import type { StaffTaskPayload } from '@clawrent/protocol';
import { printError, printSuccess } from '../output.js';

/**
 * `clawrent serve --staff-token` — Agent Staff delegate side.
 *
 * Two task-handling modes (mutually exclusive, exactly one required):
 *  - `--listen`: print every dispatched task frame to stdout (manual / external
 *    brain decides; nothing is reported back automatically).
 *  - `--exec <command>`: run the command once per task, pipe the task JSON to
 *    its stdin, and interpret its stdout as the answer (the exec bridge).
 *
 * The exec bridge is the same contract as the consumer serve stdio protocol,
 * collapsed to a single shot: a bridge command receives
 * `JSON.stringify(task)` on stdin and answers with one JSON object on stdout:
 *  - `{ proposedAction: { targetType, targetId, params }, reasoning }` →
 *    reported via staff.task_result (the result IS the proposal).
 *  - `{ error: "..." }` → reported via staff.task_error with that message.
 *  - anything else (non-zero exit, unparseable output, missing fields) →
 *    staff.task_error with 'exec failed (exit N / unparseable output)'.
 *  - a child that outlives --exec-timeout is killed → staff.task_error
 *    with 'exec timeout'.
 */

/** Resolved verdict of one exec-bridge run. */
export type ExecBridgeOutcome =
  | {
      kind: 'result';
      proposedAction: { targetType: string; targetId: string; params: Record<string, unknown> };
      reasoning: string;
    }
  | { kind: 'error'; message: string };

export interface ExecBridgeOptions {
  /** Seconds before the child is killed. Required — no silent infinite hangs. */
  timeoutSec: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Run `command` (via the shell), pipe `task` JSON to its stdin, and classify
 * its stdout per the bridge contract (see module docs). Never throws — every
 * failure path is a `{kind:'error'}` verdict, so a broken bridge degrades into
 * staff.task_error instead of killing the serve loop.
 */
export async function runTaskViaExec(
  command: string,
  task: StaffTaskPayload,
  opts: ExecBridgeOptions,
): Promise<ExecBridgeOutcome> {
  return new Promise<ExecBridgeOutcome>((resolve) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let stdout = '';
    let settled = false;
    let timedOut = false;

    const settle = (outcome: ExecBridgeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill();
      } catch {
        // Already dead — the close handler is a no-op either way.
      }
      // Drop our ends of the pipes so an orphaned shell grandchild cannot keep
      // this process's event loop pinned after we've already answered.
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle({ kind: 'error', message: 'exec timeout' });
    }, opts.timeoutSec * 1000);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });

    // Spawn-level failure (command could not even be launched). With
    // shell:true this is rare — shells usually report not-found as a non-zero
    // exit instead — but keep it mapped to the same verdict family.
    child.on('error', (err) => {
      settle({ kind: 'error', message: `exec failed (exit -1 / ${err.message})` });
    });

    child.on('close', (code) => {
      if (timedOut) return; // settled by the timeout path already

      const trimmed = stdout.trim();
      let parsed: unknown;
      if (trimmed.length > 0) {
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          parsed = undefined;
        }
      }

      // 1) Result verdict: exit 0 + parseable + proposedAction/reasoning present
      //    (and shaped so staff.task_result's schema will accept them).
      const action = isRecord(parsed) ? parsed['proposedAction'] : undefined;
      const proposedAction =
        isRecord(action) &&
        typeof action['targetType'] === 'string' &&
        typeof action['targetId'] === 'string' &&
        isRecord(action['params'])
          ? {
              targetType: action['targetType'] as string,
              targetId: action['targetId'] as string,
              params: action['params'] as Record<string, unknown>,
            }
          : undefined;
      if (code === 0 && proposedAction && typeof (parsed as Record<string, unknown>)['reasoning'] === 'string') {
        settle({
          kind: 'result',
          proposedAction,
          reasoning: (parsed as Record<string, unknown>)['reasoning'] as string,
        });
        return;
      }

      // 2) Structured error object: {error: "..."} on stdout.
      const errMsg = isRecord(parsed) ? parsed['error'] : undefined;
      if (typeof errMsg === 'string' && errMsg.length > 0) {
        settle({ kind: 'error', message: errMsg });
        return;
      }

      // 3) Everything else: non-zero exit or unparseable/shapeless output.
      settle({
        kind: 'error',
        message: `exec failed (exit ${code ?? 'signal'} / unparseable output)`,
      });
    });

    child.stdin?.write(JSON.stringify(task));
    child.stdin?.end();
  });
}

// ── CLI mode resolution ──────────────────────────────────────────────────

export type StaffMode = { mode: 'listen' } | { mode: 'exec'; command: string };

/** Validate --listen / --exec mutual exclusion (exactly one required). Throws
 *  a usage error message otherwise — the caller prints it and exits 1. */
export function resolveStaffMode(listen: boolean, exec?: string): StaffMode {
  if (listen && exec) {
    throw new Error('--listen and --exec <command> are mutually exclusive; choose exactly one');
  }
  if (!listen && !exec) {
    throw new Error('One of --listen or --exec <command> is required with --staff-token');
  }
  return listen ? { mode: 'listen' } : { mode: 'exec', command: exec as string };
}

export interface StaffServeOptions {
  staffToken: string;
  mode: StaffMode;
  execTimeoutSec: number;
  apiUrl?: string;
  wsUrl?: string;
}

/**
 * Foreground staff serve loop: connect the StaffAgentClient, ack every
 * dispatched task, then either print it (listen) or run the exec bridge and
 * report the verdict back (exec). A terminal close (staff:dead) prints and
 * exits 1; SIGINT/SIGTERM stop the client and exit 0.
 */
export async function runStaffServe(opts: StaffServeOptions): Promise<void> {
  const client = new StaffAgentClient({
    staffToken: opts.staffToken,
    ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
    ...(opts.wsUrl ? { wsUrl: opts.wsUrl } : {}),
  });

  // Terminal close (4012 invalid token / 4016 delegation dead / reconnect
  // budget exhausted): print and exit — this process is done for good.
  client.on('staff:dead', (code: number, why: string) => {
    printError(`staff connection dead (close ${code}${why ? `: ${why}` : ''})`);
    process.exit(1);
  });

  client.on('staff:error', (err: Error) => {
    printError(`staff error: ${err.message}`);
  });

  // Signal-initiated stop (stop() is idempotent) → exit 0.
  let signalStop = false;
  const shutdown = () => {
    signalStop = true;
    client.stop();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  client.on('stopped', () => {
    if (signalStop) process.exit(0);
  });

  client.on('staff:connected', () => {
    printSuccess(`staff serve connected (${opts.mode.mode === 'listen' ? 'listen' : 'exec'} mode) — waiting for tasks`);
  });

  await client.start({
    onHello: (hello) => {
      printSuccess(
        `staff hello: ${hello.displayName} (${hello.staffId}, ${hello.department}), ` +
          `${hello.grants.length} grant(s)` +
          (hello.delegation ? `, delegation "${hello.delegation.label}"` : ''),
      );
    },
    onTask: async (task, c) => {
      c.ackTask(task.id);

      if (opts.mode.mode === 'listen') {
        printSuccess(JSON.stringify({ type: 'staff.task', task }, null, 2));
        return;
      }

      const outcome = await runTaskViaExec(opts.mode.command, task, {
        timeoutSec: opts.execTimeoutSec,
      });
      if (outcome.kind === 'result') {
        printSuccess(`task ${task.id}: result (${outcome.reasoning})`);
        c.resultTask(task.id, {
          proposedAction: outcome.proposedAction,
          reasoning: outcome.reasoning,
        });
      } else {
        printError(`task ${task.id}: ${outcome.message}`);
        c.errorTask(task.id, outcome.message);
      }
    },
  });
}
