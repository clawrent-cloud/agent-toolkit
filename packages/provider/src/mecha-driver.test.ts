import { describe, it, expect } from 'vitest';
import { ClawRentMessageSchema, Mecha } from '@clawrent/protocol';
import { MechaDriver, type MechaChannel, type MechaDriverOptions } from './mecha-driver.js';

/**
 * MechaDriver unit tests (plan Task 21). A mock channel records everything the
 * driver sends (in order) and lets tests push inbound messages straight into
 * the driver's onMessage handler — fully synchronous, no timers, no network.
 */

/** Valid CapabilityManifest payload (Mecha.CapabilityManifestSchema-valid:
 * dirs/scratchDir absolute, limits complete). */
const MANIFEST = {
  sessionId: 'sess-123',
  policy: {
    dirs: ['/work/proj'],
    programs: [{ name: 'python', absPath: '/usr/bin/python' }],
    limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
  },
  mechaVersion: '0.1.0',
  scratchDir: '/work/proj/.clawrent/scratch/sess-123',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class MockMechaChannel implements MechaChannel {
  /** Everything the driver sent, in order. */
  readonly sent: unknown[] = [];
  private listener: ((msg: unknown) => void) | null = null;

  send(message: unknown): void {
    this.sent.push(message);
  }

  onMessage(cb: (msg: unknown) => void): void {
    this.listener = cb;
  }

  /** Test seam: simulate an inbound message arriving from the mecha
   * (relayed by the platform). No-op before the driver subscribed. */
  inbound(msg: unknown): void {
    this.listener?.(msg);
  }
}

function makeDriver(agentId = 'agent-driver'): {
  channel: MockMechaChannel;
  driver: MechaDriver;
  manifests: Mecha.CapabilityManifest[];
} {
  const channel = new MockMechaChannel();
  const opts: MechaDriverOptions = { channel, agentId };
  const driver = new MechaDriver(opts);
  const manifests: Mecha.CapabilityManifest[] = [];
  driver.on('attached', (m) => manifests.push(m));
  return { channel, driver, manifests };
}

/** Deliver a valid mecha.manifest so the driver is attached. */
function attach(channel: MockMechaChannel): void {
  channel.inbound({ type: 'mecha.manifest', payload: MANIFEST });
}

/** The payload of the driver's n-th outbound message (mecha.op envelope or
 * mecha.confirmResult). */
function sentPayload(channel: MockMechaChannel, n = 0): Record<string, unknown> {
  const msg = channel.sent[n] as { payload: Record<string, unknown> };
  return msg.payload;
}

/** Resolve-or-pending probe: 'pending' when p has not settled yet. */
function racePending<T>(p: Promise<T>): Promise<T | 'pending'> {
  return Promise.race([p, Promise.resolve('pending' as const)]);
}

describe('MechaDriver — attached event', () => {
  it('fires the attached callback with the manifest when mecha.manifest arrives', () => {
    const { channel, manifests } = makeDriver();
    expect(manifests).toHaveLength(0);

    attach(channel);

    expect(manifests).toHaveLength(1);
    expect(manifests[0]).toEqual(MANIFEST);
  });

  it('accepts the manifest inside a full ClawRentMessage envelope wrapper', () => {
    const { channel, manifests } = makeDriver();
    channel.inbound({
      id: 'msg-1',
      sessionId: MANIFEST.sessionId,
      timestamp: Date.now(),
      sender: { role: 'mecha', agentId: 'mecha-device-1' },
      type: 'mecha.manifest',
      payload: MANIFEST,
    });
    expect(manifests).toHaveLength(1);
  });

  it('ignores a malformed manifest payload defensively (no event, no throw)', () => {
    const { channel, manifests } = makeDriver();
    expect(() =>
      channel.inbound({ type: 'mecha.manifest', payload: { garbage: true } }),
    ).not.toThrow();
    expect(manifests).toHaveLength(0);
  });
});

describe('MechaDriver — manifest access', () => {
  it('getManifest returns null before attach and the manifest after (T22 manifest tool reads this)', () => {
    const { channel, driver } = makeDriver();
    expect(driver.getManifest()).toBeNull();

    attach(channel);

    expect(driver.getManifest()).toEqual(MANIFEST);
  });
});

describe('MechaDriver — fs/upload ops', () => {
  it('fsWrite sends a ClawRentMessage-compatible mecha.op envelope and resolves on the correlated opResult', async () => {
    const { channel, driver } = makeDriver();
    attach(channel);

    const p = driver.fsWrite('/work/proj/out.txt', 'hello', 'utf8');

    // Exactly one outbound message so far.
    expect(channel.sent).toHaveLength(1);
    const msg = channel.sent[0] as Record<string, unknown>;
    expect(msg['type']).toBe('mecha.op');
    expect(msg['sender']).toEqual({ role: 'provider', agentId: 'agent-driver' });
    expect(typeof msg['id']).toBe('string');
    expect(typeof msg['timestamp']).toBe('number');
    expect(msg['sessionId']).toBe(MANIFEST.sessionId);

    // The envelope itself is a valid ClawRentMessage (wire-shape contract).
    expect(ClawRentMessageSchema.safeParse(msg).success).toBe(true);

    const envelope = sentPayload(channel, 0) as unknown as Mecha.MechaOpEnvelope;
    expect(envelope.opId).toMatch(UUID_RE);
    expect(envelope.sessionId).toBe(MANIFEST.sessionId);
    expect(envelope.op).toEqual({
      type: 'fs.write',
      path: '/work/proj/out.txt',
      content: 'hello',
      encoding: 'utf8',
    });

    // Correlated resolution: opResult for THAT opId settles the promise.
    channel.inbound({
      type: 'mecha.opResult',
      payload: { opId: envelope.opId, ok: true, value: 'written' },
    });
    await expect(p).resolves.toEqual({
      opId: envelope.opId,
      ok: true,
      value: 'written',
    });
  });

  it('fsWrite defaults encoding to utf8', () => {
    const { channel, driver } = makeDriver();
    attach(channel);
    driver.fsWrite('/work/proj/a.txt', 'x');
    const envelope = sentPayload(channel, 0) as unknown as Mecha.MechaOpEnvelope;
    expect(envelope.op).toEqual({
      type: 'fs.write',
      path: '/work/proj/a.txt',
      content: 'x',
      encoding: 'utf8',
    });
  });

  it('every fs/upload method emits the matching op shape', () => {
    const { channel, driver } = makeDriver();
    attach(channel);

    driver.fsList('/work/proj', { depth: 2, glob: '*.txt' });
    driver.fsRead('/work/proj/a.bin', 'base64');
    driver.fsMkdir('/work/proj/sub');
    driver.fsMove('/work/proj/a', '/work/proj/b');
    driver.fsCopy('/work/proj/a', '/work/proj/c');
    driver.fsDelete('/work/proj/tmp'); // recursive defaults to false
    driver.fsDelete('/work/proj/dir', true);
    driver.upload('tool.py', 'print(1)');

    const ops = channel.sent.map(
      (m) => (m as { payload: { op: { type: string } } }).payload.op,
    );
    expect(ops[0]).toEqual({ type: 'fs.list', path: '/work/proj', depth: 2, glob: '*.txt' });
    expect(ops[1]).toEqual({ type: 'fs.read', path: '/work/proj/a.bin', encoding: 'base64' });
    expect(ops[2]).toEqual({ type: 'fs.mkdir', path: '/work/proj/sub' });
    expect(ops[3]).toEqual({ type: 'fs.move', from: '/work/proj/a', to: '/work/proj/b' });
    expect(ops[4]).toEqual({ type: 'fs.copy', from: '/work/proj/a', to: '/work/proj/c' });
    expect(ops[5]).toEqual({ type: 'fs.delete', path: '/work/proj/tmp', recursive: false });
    expect(ops[6]).toEqual({ type: 'fs.delete', path: '/work/proj/dir', recursive: true });
    expect(ops[7]).toEqual({ type: 'file.upload', name: 'tool.py', content: 'print(1)' });

    // fs.list without opts emits neither depth nor glob.
    driver.fsList('/work/proj');
    const bare = sentPayload(channel, 8) as unknown as Mecha.MechaOpEnvelope;
    expect(bare.op).toEqual({ type: 'fs.list', path: '/work/proj' });
  });

  it('exec emits an exec.run op and each call gets a fresh opId', () => {
    const { channel, driver } = makeDriver();
    attach(channel);

    const p1 = driver.exec({ argv: ['python', 'tool.py'], cwd: '/work/proj' });
    const p2 = driver.exec({
      argv: ['node', 'x.js'],
      cwd: '/work/proj',
      timeoutMs: 5000,
      env: { FOO: 'bar' },
    });

    const e1 = sentPayload(channel, 0) as unknown as Mecha.MechaOpEnvelope;
    const e2 = sentPayload(channel, 1) as unknown as Mecha.MechaOpEnvelope;
    expect(e1.op).toEqual({ type: 'exec.run', argv: ['python', 'tool.py'], cwd: '/work/proj' });
    expect(e2.op).toEqual({
      type: 'exec.run',
      argv: ['node', 'x.js'],
      cwd: '/work/proj',
      timeoutMs: 5000,
      env: { FOO: 'bar' },
    });
    expect(e1.opId).toMatch(UUID_RE);
    expect(e2.opId).toMatch(UUID_RE);
    expect(e1.opId).not.toBe(e2.opId);

    // exec exposes its opId on the returned promise so callers can register
    // chunk subscriptions BEFORE awaiting (R23 pattern).
    expect(p1.opId).toBe(e1.opId);
    expect(p2.opId).toBe(e2.opId);
  });

  it('throws synchronously when an op is attempted before attach (nothing sent)', () => {
    const { channel, driver } = makeDriver();
    expect(() => driver.fsList('/work/proj')).toThrow(/attach/i);
    expect(() => driver.fsWrite('/x', 'y')).toThrow(/attach/i);
    expect(() => driver.exec({ argv: ['ls'], cwd: '/x' })).toThrow(/attach/i);
    expect(channel.sent).toHaveLength(0);
  });

  it('fails fast on an invalid op locally (nothing sent, no pending op)', () => {
    const { channel, driver } = makeDriver();
    attach(channel);
    expect(() => driver.exec({ argv: [], cwd: '/x' })).toThrow(); // argv min 1
    expect(() => driver.fsList('/x', { depth: -1 })).toThrow(); // depth nonnegative
    expect(() => driver.fsRead('/x', 'binary' as 'utf8')).toThrow(); // bad encoding
    expect(channel.sent).toHaveLength(0);
  });

  it('correlates concurrent ops by opId (interleaved results resolve independently)', async () => {
    const { channel, driver } = makeDriver();
    attach(channel);

    const p1 = driver.fsWrite('/a', '1');
    const p2 = driver.fsWrite('/b', '2');
    const id1 = (sentPayload(channel, 0) as unknown as Mecha.MechaOpEnvelope).opId;
    const id2 = (sentPayload(channel, 1) as unknown as Mecha.MechaOpEnvelope).opId;

    // Second op's result lands first.
    channel.inbound({ type: 'mecha.opResult', payload: { opId: id2, ok: false, error: { code: 'IO_ERROR', message: 'nope' } } });
    channel.inbound({ type: 'mecha.opResult', payload: { opId: id1, ok: true } });

    await expect(p1).resolves.toEqual({ opId: id1, ok: true });
    await expect(p2).resolves.toEqual({
      opId: id2,
      ok: false,
      error: { code: 'IO_ERROR', message: 'nope' },
    });
  });
});

describe('MechaDriver — exec stream chunks', () => {
  it('delivers chunks to the onExecChunk callback registered before awaiting, and stops after the opResult', async () => {
    const { channel, driver } = makeDriver();
    attach(channel);

    const p = driver.exec({ argv: ['python', 'long.py'], cwd: '/work/proj' });
    const chunks: Mecha.MechaExecChunk[] = [];
    driver.onExecChunk(p.opId, (c) => chunks.push(c));

    channel.inbound({ type: 'mecha.execChunk', payload: { opId: p.opId, stream: 'stdout', data: 'part1', seq: 0 } });
    channel.inbound({ type: 'mecha.execChunk', payload: { opId: p.opId, stream: 'stderr', data: 'warn', seq: 1 } });
    expect(chunks.map((c) => c.data)).toEqual(['part1', 'warn']);

    channel.inbound({ type: 'mecha.opResult', payload: { opId: p.opId, ok: true, value: { stdoutTail: 'part1' } } });
    await expect(p).resolves.toMatchObject({ ok: true });

    // Stream terminal: the opResult cleaned the subscription — late chunks dropped.
    channel.inbound({ type: 'mecha.execChunk', payload: { opId: p.opId, stream: 'stdout', data: 'late', seq: 2 } });
    expect(chunks.map((c) => c.data)).toEqual(['part1', 'warn']);
  });

  it('drops chunks that arrive before onExecChunk registration for that opId (R23)', () => {
    const { channel, driver } = makeDriver();
    attach(channel);

    const p = driver.exec({ argv: ['python', 'long.py'], cwd: '/work/proj' });

    // Chunk lands BEFORE registration — dropped, not buffered, no throw.
    expect(() =>
      channel.inbound({ type: 'mecha.execChunk', payload: { opId: p.opId, stream: 'stdout', data: 'early', seq: 0 } }),
    ).not.toThrow();

    const chunks: Mecha.MechaExecChunk[] = [];
    driver.onExecChunk(p.opId, (c) => chunks.push(c));
    channel.inbound({ type: 'mecha.execChunk', payload: { opId: p.opId, stream: 'stdout', data: 'ontime', seq: 1 } });

    expect(chunks.map((c) => c.data)).toEqual(['ontime']);

    // Chunks for an unknown opId are ignored equally.
    expect(() =>
      channel.inbound({ type: 'mecha.execChunk', payload: { opId: 'unknown-op', stream: 'stdout', data: 'x', seq: 0 } }),
    ).not.toThrow();
    expect(chunks).toHaveLength(1);
  });
});

describe('MechaDriver — confirm flow', () => {
  it('fires the confirm callback on mecha.confirmRequest and approve sends mecha.confirmResult', () => {
    const { channel, driver } = makeDriver();
    attach(channel);

    const got: Mecha.MechaConfirmRequest[] = [];
    driver.onConfirmRequest((req) => got.push(req));

    const req = { requestId: 'req-1', opId: 'op-1', tier: 'T1', summary: 'write /work/proj/out.txt', detail: '42 bytes' };
    channel.inbound({ type: 'mecha.confirmRequest', payload: req });

    expect(got).toEqual([req]);

    driver.approve('req-1', true);
    expect(channel.sent).toHaveLength(1);
    const msg = channel.sent[0] as Record<string, unknown>;
    expect(msg['type']).toBe('mecha.confirmResult');
    expect(msg['sender']).toEqual({ role: 'provider', agentId: 'agent-driver' });
    expect(msg['sessionId']).toBe(MANIFEST.sessionId);
    expect(sentPayload(channel, 0)).toEqual({ requestId: 'req-1', approved: true, remember: true });
  });

  it('deny sends approved:false without a remember field', () => {
    const { channel, driver } = makeDriver();
    attach(channel);
    driver.deny('req-2');
    expect(channel.sent).toHaveLength(1);
    const msg = channel.sent[0] as Record<string, unknown>;
    expect(msg['type']).toBe('mecha.confirmResult');
    expect(sentPayload(channel, 0)).toEqual({ requestId: 'req-2', approved: false });
    expect('remember' in sentPayload(channel, 0)).toBe(false);
  });

  it('approve without remember omits the field', () => {
    const { channel, driver } = makeDriver();
    attach(channel);
    driver.approve('req-3');
    expect(sentPayload(channel, 0)).toEqual({ requestId: 'req-3', approved: true });
  });

  it('ignores an unhandled confirmRequest (no callback registered, no throw)', () => {
    // makeDriver registers an 'attached' listener but NO confirm listener.
    const { channel } = makeDriver();
    attach(channel);
    expect(() =>
      channel.inbound({ type: 'mecha.confirmRequest', payload: { requestId: 'r', opId: 'o', tier: 'T2', summary: 's' } }),
    ).not.toThrow();
    expect(channel.sent).toHaveLength(0);
  });

  it('approve/deny before attach throw synchronously (no sessionId to bind)', () => {
    const { channel, driver } = makeDriver();
    expect(() => driver.approve('req-x')).toThrow(/attach/i);
    expect(() => driver.deny('req-x')).toThrow(/attach/i);
    expect(channel.sent).toHaveLength(0);
  });
});

describe('MechaDriver — defensive inbound handling', () => {
  it('ignores an opResult whose opId matches no pending op (promise stays pending)', async () => {
    const { channel, driver } = makeDriver();
    attach(channel);

    const p = driver.fsWrite('/a', '1');
    channel.inbound({ type: 'mecha.opResult', payload: { opId: 'bogus-op', ok: true } });

    await expect(racePending(p)).resolves.toBe('pending');

    const id = (sentPayload(channel, 0) as unknown as Mecha.MechaOpEnvelope).opId;
    channel.inbound({ type: 'mecha.opResult', payload: { opId: id, ok: true, value: 7 } });
    await expect(p).resolves.toEqual({ opId: id, ok: true, value: 7 });
  });

  it('ignores malformed payloads and non-driver message types without throwing', async () => {
    const { channel, driver, manifests } = makeDriver();
    attach(channel);
    const p = driver.fsWrite('/a', '1');

    expect(() => channel.inbound(null)).not.toThrow();
    expect(() => channel.inbound('hello')).not.toThrow();
    expect(() => channel.inbound(42)).not.toThrow();
    expect(() => channel.inbound({ type: 'mecha.opResult' })).not.toThrow(); // no payload
    expect(() =>
      channel.inbound({ type: 'mecha.opResult', payload: { opId: 1, ok: 'yes' } }),
    ).not.toThrow(); // bad shape
    expect(() =>
      channel.inbound({ type: 'mecha.execChunk', payload: { opId: 'x' } }),
    ).not.toThrow(); // missing stream/data/seq
    expect(() =>
      channel.inbound({ type: 'mecha.confirmRequest', payload: { requestId: 'r' } }),
    ).not.toThrow(); // missing tier/summary
    expect(() =>
      channel.inbound({ type: 'dialogue.message', payload: { text: 'hi' } }),
    ).not.toThrow(); // not the driver's business
    expect(() =>
      channel.inbound({ type: 'mecha.manifest', payload: { sessionId: 1 } }),
    ).not.toThrow(); // malformed re-attach attempt

    expect(manifests).toHaveLength(1); // the original attach only
    await expect(racePending(p)).resolves.toBe('pending');
  });

  it('listener faults in callbacks do not break the driver', () => {
    const channel = new MockMechaChannel();
    const driver = new MechaDriver({ channel, agentId: 'agent-driver' });
    driver.on('attached', () => {
      throw new Error('listener bug');
    });
    driver.onConfirmRequest(() => {
      throw new Error('confirm listener bug');
    });
    let chunkCalls = 0;

    // attach: the faulting 'attached' listener must not break the driver...
    expect(() => attach(channel)).not.toThrow();
    // ...and a later op still works end to end.
    const p = driver.exec({ argv: ['ls'], cwd: '/x' });
    driver.onExecChunk(p.opId, () => {
      chunkCalls += 1;
    });
    expect(() =>
      channel.inbound({ type: 'mecha.confirmRequest', payload: { requestId: 'r', opId: 'o', tier: 'T1', summary: 's' } }),
    ).not.toThrow();
    channel.inbound({ type: 'mecha.execChunk', payload: { opId: p.opId, stream: 'stdout', data: 'd', seq: 0 } });
    channel.inbound({ type: 'mecha.opResult', payload: { opId: p.opId, ok: true } });

    expect(chunkCalls).toBe(1); // chunk delivery survived the faulting confirm listener
  });
});
