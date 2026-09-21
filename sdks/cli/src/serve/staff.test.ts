import { describe, it, expect } from 'vitest';
import { runTaskViaExec, resolveStaffMode } from './staff.js';
import type { StaffTaskPayload } from '@clawrent/protocol';

/** Valid dispatch-shaped task payload shared by the exec-bridge tests. */
function makeTask(): StaffTaskPayload {
  return {
    id: 't1',
    actionId: 'agent.review',
    source: 'manual',
    targetType: 'agent',
    targetId: 'a1',
    params: {},
    retryCount: 0,
    createdAt: '',
    expiresAt: null,
  };
}

describe('runTaskViaExec (exec bridge)', () => {
  it(
    'parses stdout JSON {proposedAction, reasoning} → result payload',
    async () => {
      const out = await runTaskViaExec(
        'node -e "const t=JSON.parse(require(\'fs\').readFileSync(0,\'utf8\'));process.stdout.write(JSON.stringify({proposedAction:{targetType:t.targetType,targetId:t.targetId,params:{decision:\'approve\'}},reasoning:\'ok\'}))"',
        makeTask(),
        { timeoutSec: 20 },
      );
      expect(out.kind).toBe('result');
      if (out.kind === 'result') {
        expect(out.reasoning).toBe('ok');
        expect(out.proposedAction).toEqual({
          targetType: 'agent',
          targetId: 'a1',
          params: { decision: 'approve' },
        });
      }
    },
    30_000,
  );

  it(
    'stdout {error:string} → error payload carrying the message',
    async () => {
      const out = await runTaskViaExec(
        'node -e "process.stdout.write(JSON.stringify({error:\'boom\'}))"',
        makeTask(),
        { timeoutSec: 20 },
      );
      expect(out).toEqual({ kind: 'error', message: 'boom' });
    },
    30_000,
  );

  it(
    'non-zero exit → error payload',
    async () => {
      const out = await runTaskViaExec('node -e "process.exit(3)"', makeTask(), { timeoutSec: 20 });
      expect(out.kind).toBe('error');
      if (out.kind === 'error') expect(out.message).toContain('exit 3');
    },
    30_000,
  );

  it(
    'unparseable stdout → error payload',
    async () => {
      const out = await runTaskViaExec(
        'node -e "process.stdout.write(\'not json\')"',
        makeTask(),
        { timeoutSec: 20 },
      );
      expect(out.kind).toBe('error');
      if (out.kind === 'error') expect(out.message).toContain('unparseable');
    },
    30_000,
  );

  it(
    'timeout → killed child yields "exec timeout" error',
    async () => {
      const out = await runTaskViaExec('node -e "setTimeout(()=>{},3000)"', makeTask(), {
        timeoutSec: 1,
      });
      expect(out).toEqual({ kind: 'error', message: 'exec timeout' });
    },
    30_000,
  );
});

describe('resolveStaffMode (--listen / --exec mutual exclusion)', () => {
  it('rejects when both --listen and --exec are given', () => {
    expect(() => resolveStaffMode(true, 'node agent.js')).toThrow(/mutually exclusive/i);
  });

  it('rejects when neither is given', () => {
    expect(() => resolveStaffMode(false, undefined)).toThrow(/--listen or --exec/);
  });

  it('rejects an empty --exec string as "neither"', () => {
    expect(() => resolveStaffMode(false, '')).toThrow(/--listen or --exec/);
  });

  it('listen only → listen mode', () => {
    expect(resolveStaffMode(true, undefined)).toEqual({ mode: 'listen' });
  });

  it('exec only → exec mode carrying the command', () => {
    expect(resolveStaffMode(false, 'node agent.js')).toEqual({
      mode: 'exec',
      command: 'node agent.js',
    });
  });
});
