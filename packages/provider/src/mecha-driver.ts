import { randomUUID } from 'node:crypto';
import { Mecha } from '@clawrent/protocol';

/**
 * MechaDriver — the driver-side SDK for ClawRent mecha sessions (plan Task 21;
 * spec §9 SDK layer 2). Every method here is the steering wheel for exactly one
 * wire action: fs/upload/exec ops become one `mecha.op` message each (results
 * correlated back by opId); approve/deny become one `mecha.confirmResult`.
 *
 * Ruling R3 — channel abstraction, NOT ProviderClient: the driver is built
 * against a minimal channel interface so the transport stays swappable.
 * Production adapters (provider serve runtime -> platform session bus) come
 * later with the platform-side plan; Task 21 unit tests inject a mock channel
 * and Task 24 e2e bridges the channel to the mock relay.
 *
 * Message shapes: outbound messages are ClawRentMessage-compatible envelopes
 * `{ id, sessionId, timestamp, sender: { role: 'provider', agentId }, type,
 * payload }` (`targetSlot`/`signature` deliberately absent in v0 — mecha
 * routing is type-based). Inbound messages are consumed defensively: only
 * `type` + `payload` are read, and every payload is validated with the
 * payload-level Mecha namespace schemas (CapabilityManifestSchema /
 * MechaOpResultSchema / MechaExecChunkSchema / MechaConfirmRequestSchema).
 * Anything that fails the shape check — or carries a type the driver does not
 * own — is silently ignored. The outer envelope fields are intentionally NOT
 * validated: the driver's contract is the payload, and platform-side envelope
 * evolution must not break the driver.
 *
 * Lifecycle: construct -> `on('attached', ...)` -> ops. The 'attached' event
 * fires when a `mecha.manifest` message arrives; the manifest carries the
 * sessionId every subsequent envelope binds to, plus the capability boundary
 * (policy) the mecha will enforce. There is deliberately NO 'detached' event:
 * v0 has no explicit detach message on the wire, and link teardown is the
 * channel adapter's concern.
 *
 * Exec streaming (ruling R23): chunks are correlated per opId. Chunks arriving
 * BEFORE `onExecChunk(opId, cb)` registration are DROPPED (never buffered);
 * register before awaiting `exec()` if you want the stream — that is why the
 * promise returned by `exec()` carries its `opId`. The opResult is the stream
 * terminal: it resolves the pending op AND removes that opId's subscription
 * (late chunks are dropped). Full output tails still arrive in the result
 * value, so a dropped early chunk degrades streaming, not correctness.
 *
 * Confirm flow: `mecha.confirmRequest` -> onConfirmRequest callbacks. A
 * request with no registered callback is simply never answered and times out
 * at the mecha (policy.limits.confirmTimeoutMs, default 300s, default-deny).
 * `approve`/`deny` answer immediately with a `mecha.confirmResult`.
 *
 * No driver-side timeouts (ruling): the mecha owns ALL timing (confirm
 * timeout, exec timeout, link grace). A pending op whose result never comes
 * stays pending — a dropped link is the adapter's concern. Unmatched results
 * (late/unknown opId) are silently ignored.
 *
 * Cut from v0 (ruling R24, conscious plan deviation): `requestExpansion` is
 * NOT implemented. Policy expansion is platform-mediated (consumer approves on
 * the web; the mecha enforces — spec §7.7) and that platform flow does not
 * exist yet; the SDK does not invent off-protocol messages. The planned MCP
 * tool `clawrent_mecha_request_expansion` is cut with it (Task 22 mirrors).
 *
 * Fail-fast discipline: calling any send-side method before the manifest
 * arrived throws synchronously (no sessionId -> no envelope to bind). Outgoing
 * ops are validated against MechaOpSchema before send — without a driver-side
 * timeout, a malformed op that slips onto the wire would hang its promise
 * forever, so the local gate is mandatory.
 */

/** Minimal transport the driver rides on (ruling R3). `send` delivers one
 * outbound message; `onMessage` registers the single inbound listener. The
 * driver registers its listener once in the constructor. Production adapters
 * (serve runtime -> platform session bus) are out of scope for v0. */
export interface MechaChannel {
  send(message: unknown): void;
  onMessage(cb: (msg: unknown) => void): void;
}

export interface MechaDriverOptions {
  channel: MechaChannel;
  /** Stamped into every outbound envelope's `sender.agentId`. */
  agentId: string;
}

/** fs.list options (`depth`/`glob` mirror the fs.list op fields). */
export interface MechaListOptions {
  depth?: number;
  glob?: string;
}

/** exec.run input (mirrors the exec.run op fields). */
export interface MechaExecInput {
  argv: string[];
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

/** Inbound message types the driver consumes; everything else is ignored. */
type DriverInboundType = 'mecha.manifest' | 'mecha.opResult' | 'mecha.execChunk' | 'mecha.confirmRequest';

interface PendingOp {
  resolve: (result: Mecha.MechaOpResult) => void;
}

export class MechaDriver {
  private readonly channel: MechaChannel;
  private readonly agentId: string;

  /** The attached manifest; null until mecha.manifest arrives. Source of the
   * sessionId stamped into every outbound envelope. */
  private manifest: Mecha.CapabilityManifest | null = null;

  /** opId -> resolver. No timeouts by ruling; entries leave only when their
   * correlated opResult arrives. */
  private readonly pendingOps = new Map<string, PendingOp>();

  /** opId -> chunk callbacks (R23). Created only by onExecChunk; removed when
   * the op's opResult arrives (stream terminal). */
  private readonly chunkSubs = new Map<string, Set<(chunk: Mecha.MechaExecChunk) => void>>();

  private readonly attachedCbs = new Set<(m: Mecha.CapabilityManifest) => void>();
  private readonly confirmCbs = new Set<(req: Mecha.MechaConfirmRequest) => void>();

  constructor(opts: MechaDriverOptions) {
    this.channel = opts.channel;
    this.agentId = opts.agentId;
    this.channel.onMessage((msg) => this.handleMessage(msg));
  }

  /** Subscribe to driver events. Only 'attached' exists in v0 (no detach
   * message on the wire — see file header). */
  on(event: 'attached', cb: (m: Mecha.CapabilityManifest) => void): void {
    if (event !== 'attached') return; // unreachable with the literal type; guards future event names
    this.attachedCbs.add(cb);
  }

  // ── fs / upload / exec ops ────────────────────────────────────────────────

  fsList(path: string, opts?: MechaListOptions): Promise<Mecha.MechaOpResult> {
    const op: Extract<Mecha.MechaOp, { type: 'fs.list' }> = { type: 'fs.list', path };
    if (opts?.depth !== undefined) op.depth = opts.depth;
    if (opts?.glob !== undefined) op.glob = opts.glob;
    return this.sendOp(op).promise;
  }

  fsRead(path: string, encoding: 'utf8' | 'base64'): Promise<Mecha.MechaOpResult> {
    return this.sendOp({ type: 'fs.read', path, encoding }).promise;
  }

  fsWrite(path: string, content: string, encoding: 'utf8' | 'base64' = 'utf8'): Promise<Mecha.MechaOpResult> {
    return this.sendOp({ type: 'fs.write', path, content, encoding }).promise;
  }

  fsMkdir(path: string): Promise<Mecha.MechaOpResult> {
    return this.sendOp({ type: 'fs.mkdir', path }).promise;
  }

  fsMove(from: string, to: string): Promise<Mecha.MechaOpResult> {
    return this.sendOp({ type: 'fs.move', from, to }).promise;
  }

  fsCopy(from: string, to: string): Promise<Mecha.MechaOpResult> {
    return this.sendOp({ type: 'fs.copy', from, to }).promise;
  }

  fsDelete(path: string, recursive = false): Promise<Mecha.MechaOpResult> {
    return this.sendOp({ type: 'fs.delete', path, recursive }).promise;
  }

  /** Upload a driver tool/script into the session scratch area (the ONLY
   * driver-controlled write channel; lands in the provenance table as T1). */
  upload(name: string, content: string): Promise<Mecha.MechaOpResult> {
    return this.sendOp({ type: 'file.upload', name, content }).promise;
  }

  /** Run a whitelisted program. The returned promise carries its `opId` so
   * callers can `onExecChunk(p.opId, cb)` BEFORE awaiting (R23 — chunks are
   * dropped, not buffered, when they arrive before registration). */
  exec(op: MechaExecInput): Promise<Mecha.MechaOpResult> & { opId: string } {
    const wire: Extract<Mecha.MechaOp, { type: 'exec.run' }> = {
      type: 'exec.run',
      argv: op.argv,
      cwd: op.cwd,
    };
    if (op.timeoutMs !== undefined) wire.timeoutMs = op.timeoutMs;
    if (op.env !== undefined) wire.env = op.env;
    return this.sendOp(wire).promise;
  }

  /** Subscribe to exec.run stream chunks for one op (stdout/stderr, seq-
   * ordered). Register BEFORE awaiting exec() — earlier chunks are dropped
   * (R23). The subscription ends automatically when the op's opResult arrives. */
  onExecChunk(opId: string, cb: (chunk: Mecha.MechaExecChunk) => void): void {
    let subs = this.chunkSubs.get(opId);
    if (subs === undefined) {
      subs = new Set();
      this.chunkSubs.set(opId, subs);
    }
    subs.add(cb);
  }

  // ── confirm flow (human-in-the-loop) ─────────────────────────────────────

  /** Subscribe to mecha.confirmRequest deliveries. Requests arriving before
   * any callback is registered are simply never answered (the mecha's 300s
   * confirm timeout default-denies them). */
  onConfirmRequest(cb: (req: Mecha.MechaConfirmRequest) => void): void {
    this.confirmCbs.add(cb);
  }

  /** Approve a pending confirm request. `remember` is passed through verbatim
   * (v0 semantics live on the consumer side). Throws before attach. */
  approve(requestId: string, remember?: boolean): void {
    const payload: Mecha.MechaConfirmResult =
      remember === undefined ? { requestId, approved: true } : { requestId, approved: true, remember };
    this.send('mecha.confirmResult', payload);
  }

  /** Deny a pending confirm request. Throws before attach. */
  deny(requestId: string): void {
    this.send('mecha.confirmResult', { requestId, approved: false });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** Validate + send one op, register its pending resolver, and return both
   * the envelope (with the fresh opId) and the correlated promise. */
  private sendOp(op: Mecha.MechaOp): {
    envelope: Mecha.MechaOpEnvelope;
    promise: Promise<Mecha.MechaOpResult> & { opId: string };
  } {
    // Local shape gate (fail-fast): a malformed op on the wire would hang its
    // promise forever (no driver-side timeout), so it must never leave home.
    const parsed = Mecha.MechaOpSchema.safeParse(op);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue ? `${issue.path.map(String).join('.')}` : '';
      throw new Error(
        `MechaDriver: refusing to send invalid op (${where} ${issue?.message ?? 'schema mismatch'})`,
      );
    }
    const envelope: Mecha.MechaOpEnvelope = {
      opId: randomUUID(),
      sessionId: this.requireSessionId(),
      op: parsed.data,
    };
    let resolve!: (result: Mecha.MechaOpResult) => void;
    const promise = new Promise<Mecha.MechaOpResult>((res) => {
      resolve = res;
    }) as Promise<Mecha.MechaOpResult> & { opId: string };
    promise.opId = envelope.opId;
    this.pendingOps.set(envelope.opId, { resolve });
    this.send('mecha.op', envelope);
    return { envelope, promise };
  }

  private requireSessionId(): string {
    if (this.manifest === null) {
      throw new Error(
        'MechaDriver: not attached — no mecha.manifest received yet, so there is no sessionId to bind this message to',
      );
    }
    return this.manifest.sessionId;
  }

  /** Build a ClawRentMessage-compatible envelope and hand it to the channel.
   * targetSlot/signature deliberately absent in v0 (mecha routing is
   * type-based). */
  private send(
    type: 'mecha.op' | 'mecha.confirmResult',
    payload: Mecha.MechaOpEnvelope | Mecha.MechaConfirmResult,
  ): void {
    this.channel.send({
      id: randomUUID(),
      sessionId: this.requireSessionId(),
      timestamp: Date.now(),
      sender: { role: 'provider', agentId: this.agentId },
      type,
      payload,
    });
  }

  /** Defensive inbound dispatch: structural gate on the envelope, payload-
   * level schema validation per type, silent drop on any mismatch. Listener
   * faults never break the driver. */
  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null) return;
    const msg = raw as Record<string, unknown>;
    const type = msg['type'];
    const payload = msg['payload'];
    if (typeof type !== 'string' || typeof payload !== 'object' || payload === null) return;
    if (!(this.isDriverInboundType(type))) return;

    switch (type) {
      case 'mecha.manifest': {
        const parsed = Mecha.CapabilityManifestSchema.safeParse(payload);
        if (!parsed.success) return;
        this.manifest = parsed.data;
        for (const cb of this.attachedCbs) {
          try {
            cb(parsed.data);
          } catch {
            // listener fault isolated (same discipline as the mecha-side session)
          }
        }
        return;
      }
      case 'mecha.opResult': {
        const parsed = Mecha.MechaOpResultSchema.safeParse(payload);
        if (!parsed.success) return;
        const pending = this.pendingOps.get(parsed.data.opId);
        if (pending === undefined) return; // late/unknown opId — ignore, no timeout exists
        this.pendingOps.delete(parsed.data.opId);
        // Stream terminal: the result ends this op's chunk subscription (R23).
        this.chunkSubs.delete(parsed.data.opId);
        pending.resolve(parsed.data);
        return;
      }
      case 'mecha.execChunk': {
        const parsed = Mecha.MechaExecChunkSchema.safeParse(payload);
        if (!parsed.success) return;
        const subs = this.chunkSubs.get(parsed.data.opId);
        if (subs === undefined) return; // before registration / after terminal — dropped (R23)
        for (const cb of subs) {
          try {
            cb(parsed.data);
          } catch {
            // listener fault isolated
          }
        }
        return;
      }
      case 'mecha.confirmRequest': {
        const parsed = Mecha.MechaConfirmRequestSchema.safeParse(payload);
        if (!parsed.success) return;
        for (const cb of this.confirmCbs) {
          try {
            cb(parsed.data);
          } catch {
            // listener fault isolated
          }
        }
        return;
      }
    }
  }

  private isDriverInboundType(type: string): type is DriverInboundType {
    return (
      type === 'mecha.manifest' ||
      type === 'mecha.opResult' ||
      type === 'mecha.execChunk' ||
      type === 'mecha.confirmRequest'
    );
  }
}
