import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { MECHA_PACKAGE_VERSION } from './constants.js';
import {
  MechaSession,
  type MechaPolicyUpdateFrame,
  type MechaSessionEndEvent,
  type MechaSessionOfferFrame,
} from './session.js';
import { ProvenanceStore } from './enforcement/provenance.js';
import { DashcamLogger } from './logging.js';
import type { ExecutorLogger } from './ops/executor.js';

// ── fixture 基建（os.tmpdir，plan 全局约束）────────────────────────────────

const created: string[] = [];

function makeWorkspace(prefix: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// 假时钟用例（宽限 60s / 确认超时 300s）各自 useFakeTimers，统一兜底还原
afterEach(() => {
  vi.useRealTimers();
});

// ── 装配：真实 fs + 真实 ProvenanceStore + mock confirm/log ─────────────────

/** 程序表钉死的 node 登记真身（裸名 'node' → 本机 node.exe）。 */
const NODE: Mecha.MechaProgramEntry = { name: 'node', absPath: process.execPath };

interface Harness {
  session: MechaSession;
  confirm: ReturnType<typeof vi.fn>;
  logOp: ReturnType<typeof vi.fn>;
  logLifecycle: ReturnType<typeof vi.fn>;
  provenance: ProvenanceStore;
  ws: string;
  realWs: string;
  ws2: string;
  realWs2: string;
  policy: Mecha.MechaPolicy;
  /** 标准会话（sess-1，首白名单 ws）的预期 scratch 路径。 */
  scratchDir: string;
  attached: Mecha.CapabilityManifest[];
  ended: MechaSessionEndEvent[];
  policyUpdates: Array<{ frame: MechaPolicyUpdateFrame; applied: boolean }>;
  /** holdConfirm 时释放挂起确认（迟到批准用）。 */
  releaseConfirm: (r: { approved: boolean; remember?: boolean }) => void;
  acceptOffer(): void;
}

function offerFrame(
  policy: Mecha.MechaPolicy,
  sessionId = 'sess-1',
): MechaSessionOfferFrame {
  return {
    type: 'session.offer',
    sessionId,
    orderRef: 'order-1',
    driverAgentId: 'driver-1',
    policy,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  };
}

function env(op: Mecha.MechaOp, opId = 'op-1'): Mecha.MechaOpEnvelope {
  return { opId, sessionId: 'sess-1', op };
}

function makeHarness(opts?: {
  holdConfirm?: boolean;
  /** 确认批复语义（I3）：approved 缺省 true；remember=true 时批复携带记忆位。 */
  approved?: boolean;
  remember?: boolean;
}): Harness {
  const ws = makeWorkspace('mecha-session-');
  const realWs = fs.realpathSync.native(ws);
  const ws2 = makeWorkspace('mecha-session2-');
  const realWs2 = fs.realpathSync.native(ws2);
  const provenance = new ProvenanceStore(join(ws, 'provenance.json'));
  const policy: Mecha.MechaPolicy = {
    dirs: [ws],
    programs: [NODE],
    limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
  };
  const confirm = vi.fn(
    (req: Mecha.MechaConfirmRequest): Promise<Mecha.MechaConfirmResult> => {
      if (opts?.holdConfirm === true) {
        return new Promise((resolve) => {
          h.releaseConfirm = (r) =>
            resolve({
              requestId: req.requestId,
              approved: r.approved,
              ...(r.remember === true ? { remember: true } : {}),
            });
        });
      }
      return Promise.resolve({
        requestId: req.requestId,
        approved: opts?.approved ?? true,
        ...(opts?.remember === true ? { remember: true } : {}),
      });
    },
  );
  const logOp = vi.fn();
  const logLifecycle = vi.fn();
  const log: ExecutorLogger = { logOpStart: vi.fn(), logOp };
  const attached: Mecha.CapabilityManifest[] = [];
  const ended: MechaSessionEndEvent[] = [];
  const policyUpdates: Array<{ frame: MechaPolicyUpdateFrame; applied: boolean }> =
    [];
  const session = new MechaSession({
    provenance,
    confirm,
    log,
    logLifecycle,
    onPolicyUpdate: (frame, applied) => {
      policyUpdates.push({ frame, applied });
    },
  });
  session.on('attached', (m) => attached.push(m));
  session.on('ended', (e) => ended.push(e));
  const h: Harness = {
    session,
    confirm,
    logOp,
    logLifecycle,
    provenance,
    ws,
    realWs,
    ws2,
    realWs2,
    policy,
    scratchDir: join(ws, '.clawrent', 'scratch', 'sess-1'),
    attached,
    ended,
    policyUpdates,
    releaseConfirm: () => {},
    acceptOffer() {
      const d = session.offer(offerFrame(policy, 'sess-1'));
      if (d.decision !== 'accept') throw new Error(`acceptOffer 失败: ${d.reason}`);
    },
  };
  return h;
}

/** 真实时钟确定性等待（poll 条件而非 sleep 猜时序）。 */
async function waitForCondition(
  cond: () => boolean,
  label: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`condition not met: ${label}`);
}

// ── offer / 独占（A7）─────────────────────────────────────────────────────

describe('MechaSession offer 与独占', () => {
  it('合法 offer → accept：armed、scratch 建立、attached 事件带 CapabilityManifest', () => {
    const h = makeHarness();
    h.acceptOffer();

    expect(h.session.state).toBe('armed');
    expect(h.attached).toHaveLength(1);
    const m = h.attached[0]!; // 上行 length 断言已钉非空
    expect(m.sessionId).toBe('sess-1');
    expect(m.mechaVersion).toBe(MECHA_PACKAGE_VERSION);
    expect(m.policy).toEqual(h.policy);
    // 盘上规范形比较（win32 8.3 短名免疫）
    expect(fs.realpathSync.native(m.scratchDir)).toBe(
      fs.realpathSync.native(h.scratchDir),
    );
    expect(fs.existsSync(h.scratchDir)).toBe(true);
  });

  it('armed 时第二个 offer 拒（独占 A7）：reason busy、状态不变', () => {
    const h = makeHarness();
    h.acceptOffer();

    const d = h.session.offer(offerFrame(h.policy, 'sess-2'));
    expect(d).toEqual({ decision: 'reject', reason: 'busy' });
    expect(h.session.state).toBe('armed');

    // paused 同样独占（仍未 idle）
    h.session.pause();
    expect(h.session.offer(offerFrame(h.policy, 'sess-3'))).toMatchObject({
      decision: 'reject',
      reason: 'busy',
    });
    expect(h.session.state).toBe('paused');
  });

  it('非 session.offer 帧与垃圾输入 → reject invalid offer，状态不变', () => {
    const h = makeHarness();
    expect(h.session.offer({ type: 'heartbeat' })).toEqual({
      decision: 'reject',
      reason: 'invalid offer',
    });
    expect(h.session.offer('garbage')).toEqual({
      decision: 'reject',
      reason: 'invalid offer',
    });
    expect(h.session.state).toBe('idle');
  });

  it('sessionId 含路径分隔符 → reject（即焚路径逃逸防线），盘上无痕迹', () => {
    const h = makeHarness();
    expect(h.session.offer(offerFrame(h.policy, '../evil')).decision).toBe(
      'reject',
    );
    expect(h.session.offer(offerFrame(h.policy, '..\\evil')).decision).toBe(
      'reject',
    );
    expect(fs.existsSync(join(h.ws, '.clawrent'))).toBe(false);
    expect(h.session.state).toBe('idle');
  });

  it('sessionId 含冒号 → reject（NTFS ADS 流名防线，I1；日志文件名同规则），盘上无痕迹', () => {
    const h = makeHarness();
    expect(h.session.offer(offerFrame(h.policy, 'sess:ads')).decision).toBe(
      'reject',
    );
    expect(fs.existsSync(join(h.ws, '.clawrent'))).toBe(false);
    expect(h.session.state).toBe('idle');
  });

  it('policy.dirs 为空 → reject（scratch 无落点，fail-closed）', () => {
    const h = makeHarness();
    const d = h.session.offer(offerFrame({ ...h.policy, dirs: [] }));
    expect(d.decision).toBe('reject');
    expect(h.session.state).toBe('idle');
  });

  it('end 后可再 offer 新会话：新 scratch、新 policy、独占解除', () => {
    const h = makeHarness();
    h.acceptOffer();
    h.session.disarm('completed');

    const policy2: Mecha.MechaPolicy = { ...h.policy, dirs: [h.ws2] };
    const d = h.session.offer(offerFrame(policy2, 'sess-2'));
    expect(d.decision).toBe('accept');
    expect(h.session.state).toBe('armed');
    const scratch2 = join(h.ws2, '.clawrent', 'scratch', 'sess-2');
    expect(fs.existsSync(scratch2)).toBe(true);
    expect(h.attached).toHaveLength(2);
    expect(h.attached[1]?.sessionId).toBe('sess-2');
  });
});

// ── pause / resume 与 op 守卫 ─────────────────────────────────────────────

describe('MechaSession pause/resume 与 op 守卫', () => {
  it('pause/resume：armed↔paused 状态转换', () => {
    const h = makeHarness();
    h.acceptOffer();
    h.session.pause();
    expect(h.session.state).toBe('paused');
    h.session.resume();
    expect(h.session.state).toBe('armed');
  });

  it('idle 时 pause/resume 抛错（本地 API 契约响亮）', () => {
    const h = makeHarness();
    expect(() => h.session.pause()).toThrow();
    expect(() => h.session.resume()).toThrow();
  });

  it('idle 时 op 拒：IO_ERROR no active session', async () => {
    const h = makeHarness();
    const r = await h.session.executeOp(env({ type: 'fs.list', path: '.' }));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('IO_ERROR');
    expect(r.error?.message).toBe('no active session');
  });

  it('paused 时 op 全拒：IO_ERROR paused，无确认弹窗（不写盘）', async () => {
    const h = makeHarness();
    h.acceptOffer();
    h.session.pause();

    const r = await h.session.executeOp(
      env({ type: 'fs.write', path: 'p.txt', content: 'P', encoding: 'utf8' }, 'op-p'),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('IO_ERROR');
    expect(r.error?.message).toBe('paused');
    expect(h.confirm).not.toHaveBeenCalled(); // 无确认提示
    expect(fs.existsSync(join(h.realWs, 'p.txt'))).toBe(false);
  });
});

// ── 断链失电（断链即失电：宁杀勿失控）─────────────────────────────────────

describe('MechaSession 断链失电', () => {
  it('断链杀运行中子进程（killActiveExec 真收割，非内存标记）', async () => {
    const h = makeHarness();
    h.acceptOffer();

    // 慢 exec 占位：子进程落 started（含自身 pid）后永驻
    const started = join(h.ws, 'exec.started');
    const script = join(h.ws, 'hang.cjs');
    fs.writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(started)}, String(process.pid)); setInterval(() => {}, 1000);`,
    );
    const pending = h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', script], cwd: '.' }, 'op-exec'),
    );
    await waitForCondition(() => fs.existsSync(started), 'exec 子进程启动');
    const pid = Number(fs.readFileSync(started, 'utf8'));

    h.session.markLinkDown();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('IO_ERROR');
    expect((result.value as { killed?: boolean }).killed).toBe(true);
    // 进程真死（轮询 kill(pid,0) 报 ESRCH）
    await waitForCondition(() => {
      try {
        process.kill(pid, 0);
        return false;
      } catch {
        return true;
      }
    }, '子进程已死');

    h.session.disarm('completed'); // 收尾：清宽限计时器
  });

  it('断链立即停收新 op：IO_ERROR link down（不排队，立即拒）', async () => {
    const h = makeHarness();
    h.acceptOffer();
    h.session.markLinkDown();

    const r = await h.session.executeOp(env({ type: 'fs.list', path: '.' }, 'op-down'));
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('IO_ERROR');
    expect(r.error?.message).toBe('link down');
    h.session.disarm('completed');
  });

  it('断链取消等待中的确认：op 立败、迟到批准不得放行（T11 约束 #1）', async () => {
    const h = makeHarness({ holdConfirm: true });
    h.acceptOffer();
    const target = join(h.realWs, 'late.txt');

    const r = h.session.executeOp(
      env({ type: 'fs.write', path: 'late.txt', content: 'L', encoding: 'utf8' }, 'op-late'),
    );
    await waitForCondition(() => h.confirm.mock.calls.length === 1, '确认已发出');
    h.session.markLinkDown();

    const result = await r;
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('IO_ERROR');
    expect(result.error?.message).toBe('link down');
    expect(fs.existsSync(target)).toBe(false);

    // 迟到批准：确认已取消，绝不放行写盘
    h.releaseConfirm({ approved: true });
    await new Promise((r2) => setImmediate(r2));
    expect(fs.existsSync(target)).toBe(false);

    h.session.disarm('completed');
  });

  it('宽限内 markLinkUp → resumed：恢复收 op（fake 时钟，59.999s）', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.acceptOffer();
    h.session.markLinkDown();

    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.session.markLinkUp()).toBe('resumed');
    expect(h.session.state).toBe('armed');
    expect(h.ended).toEqual([]);

    const r = await h.session.executeOp(env({ type: 'fs.list', path: '.' }, 'op-after'));
    expect(r.ok).toBe(true);
  });

  it('宽限超时自动 end：grace_expired + 即焚 + idle；markLinkUp → grace_expired', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.acceptOffer();
    fs.writeFileSync(join(h.scratchDir, 'residue.txt'), 'x');

    h.session.markLinkDown();
    expect(h.session.state).toBe('armed'); // 断链不改 state（op 拒靠 linkDown 闸）

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.session.state).toBe('idle');
    expect(h.ended).toEqual([{ reason: 'grace_expired' }]);
    expect(fs.existsSync(h.scratchDir)).toBe(false);
    expect(h.session.markLinkUp()).toBe('grace_expired');
  });

  it('未断链时 markLinkUp → grace_expired（无可恢复）', () => {
    const h = makeHarness();
    h.acceptOffer();
    expect(h.session.markLinkUp()).toBe('grace_expired');
    expect(h.session.state).toBe('armed');
  });

  it('断链期间保持 paused 态：重连后仍 paused（resume 前拒 op）', async () => {
    const h = makeHarness();
    h.acceptOffer();
    h.session.pause();
    h.session.markLinkDown();
    h.session.markLinkUp();

    expect(h.session.state).toBe('paused');
    const r = await h.session.executeOp(env({ type: 'fs.list', path: '.' }, 'op-1'));
    expect(r.error?.message).toBe('paused');

    h.session.resume();
    const r2 = await h.session.executeOp(env({ type: 'fs.list', path: '.' }, 'op-2'));
    expect(r2.ok).toBe(true);
  });
});

// ── 即焚（disarm / session.end）───────────────────────────────────────────

describe('MechaSession 即焚与终局', () => {
  it('disarm：scratch 焚、非 scratch 交付物在、provenance 保留、ended 事件、idle', async () => {
    const h = makeHarness();
    h.acceptOffer();

    // 交付物：白名单内 fs.write（非 scratch）
    const w = await h.session.executeOp(
      env({ type: 'fs.write', path: 'deliverable.txt', content: 'D', encoding: 'utf8' }, 'op-d'),
    );
    expect(w.ok).toBe(true);
    // 驾驶员上传：落 scratch
    const u = await h.session.executeOp(
      env({ type: 'file.upload', name: 'tool.js', content: 'console.log(1)' }, 'op-u'),
    );
    expect(u.ok).toBe(true);
    const scratchFileReal = fs.realpathSync.native(join(h.scratchDir, 'tool.js'));

    h.session.disarm('completed');

    expect(fs.existsSync(h.scratchDir)).toBe(false); // 即焚
    expect(fs.existsSync(join(h.realWs, 'deliverable.txt'))).toBe(true); // 交付物不焚
    expect(h.provenance.isDriverAuthored(scratchFileReal)).toBe(true); // provenance 永不清
    expect(h.ended).toEqual([{ reason: 'completed' }]);
    expect(h.session.state).toBe('idle');
  });

  it('disarm 幂等：ended 恰一次', () => {
    const h = makeHarness();
    h.acceptOffer();
    h.session.disarm('completed');
    h.session.disarm('platform');
    expect(h.ended).toEqual([{ reason: 'completed' }]);
    expect(h.session.state).toBe('idle');
  });

  it('end 后：在途 op 随确认取消立败、排队 op 拒 session ended 不执行', async () => {
    const h = makeHarness({ holdConfirm: true });
    h.acceptOffer();

    const opA = h.session.executeOp(
      env({ type: 'fs.write', path: 'a.txt', content: 'A', encoding: 'utf8' }, 'op-a'),
    );
    await waitForCondition(() => h.confirm.mock.calls.length === 1, 'opA 确认已发出');
    const opB = h.session.executeOp(env({ type: 'fs.list', path: '.' }, 'op-b'));

    h.session.disarm('consumer_halt');

    const ra = await opA;
    expect(ra.ok).toBe(false);
    expect(ra.error?.code).toBe('IO_ERROR'); // 确认被取消
    const rb = await opB;
    expect(rb.ok).toBe(false);
    expect(rb.error?.message).toBe('session ended'); // 排队 op 不落执行器
    expect(fs.existsSync(join(h.realWs, 'a.txt'))).toBe(false);
  });

  it('handleFrame 路由：非 session 帧忽略、session.pause / session.end 生效', () => {
    const h = makeHarness();
    h.acceptOffer();

    expect(h.session.handleFrame({ type: 'heartbeat' })).toBeUndefined();
    expect(h.session.handleFrame({ type: 'session.pause' })).toEqual({
      decision: 'accept',
    });
    expect(h.session.state).toBe('paused');
    expect(h.session.handleFrame({ type: 'session.end', reason: 'consumer_halt' })).toEqual(
      { decision: 'accept' },
    );
    expect(h.ended).toEqual([{ reason: 'consumer_halt' }]);
    expect(h.session.state).toBe('idle');
  });

  it('handleFrame：idle 时 pause/end 拒（no active session）', () => {
    const h = makeHarness();
    expect(h.session.handleFrame({ type: 'session.pause' })).toEqual({
      decision: 'reject',
      reason: 'no active session',
    });
    expect(h.session.handleFrame({ type: 'session.end', reason: 'platform' })).toEqual({
      decision: 'reject',
      reason: 'no active session',
    });
  });
});

// ── policy.update ─────────────────────────────────────────────────────────

describe('MechaSession policy.update', () => {
  it('tighten 即刻生效：替换后首个 op 按新限额判（onPolicyUpdate applied=true）', async () => {
    const h = makeHarness();
    h.acceptOffer();

    const before = await h.session.executeOp(
      env({ type: 'fs.write', path: 'ok.txt', content: '123456', encoding: 'utf8' }, 'op-pre'),
    );
    expect(before.ok).toBe(true); // 默认限额下 6 字节可写

    const tightened: Mecha.MechaPolicy = {
      ...h.policy,
      limits: { ...h.policy.limits, maxFileBytes: 5 },
    };
    const out = h.session.policyUpdate({
      type: 'policy.update',
      policy: tightened,
      direction: 'tighten',
    });
    expect(out.applied).toBe(true);
    expect(h.policyUpdates.at(-1)?.applied).toBe(true);

    const after = await h.session.executeOp(
      env({ type: 'fs.write', path: 'big.txt', content: '123456', encoding: 'utf8' }, 'op-post'),
    );
    expect(after.error?.code).toBe('SIZE_LIMIT'); // 新限额即刻生效
  });

  it('expand 无 authorizationRef → 硬拒：applied=false、policy 不变、状态不变', async () => {
    const h = makeHarness();
    h.acceptOffer();

    // expand 载荷实则收紧（maxFileBytes→5）：若被误应用，后续 6 字节写将 SIZE_LIMIT
    const narrowed: Mecha.MechaPolicy = {
      ...h.policy,
      limits: { ...h.policy.limits, maxFileBytes: 5 },
    };
    const out = h.session.policyUpdate({
      type: 'policy.update',
      policy: narrowed,
      direction: 'expand',
    });
    expect(out.applied).toBe(false);
    expect(out.error).toBeTruthy();
    expect(h.policyUpdates.at(-1)?.applied).toBe(false);

    const verify = await h.session.executeOp(
      env({ type: 'fs.write', path: 'verify.txt', content: '123456', encoding: 'utf8' }, 'op-v'),
    );
    expect(verify.ok).toBe(true); // 旧策略仍在位
    expect(h.session.state).toBe('armed');
  });

  it('expand 带 authorizationRef → 替换生效：新白名单目录可写', async () => {
    const h = makeHarness();
    h.acceptOffer();

    const pre = await h.session.executeOp(
      env({ type: 'fs.write', path: join(h.ws2, 'pre.txt'), content: 'x', encoding: 'utf8' }, 'op-pre'),
    );
    expect(pre.error?.code).toBe('PATH_DENIED'); // 扩前 ws2 越界

    const widened: Mecha.MechaPolicy = { ...h.policy, dirs: [h.ws, h.ws2] };
    const out = h.session.policyUpdate({
      type: 'policy.update',
      policy: widened,
      direction: 'expand',
      authorizationRef: 'auth-123',
    });
    expect(out.applied).toBe(true);
    expect(h.policyUpdates.at(-1)?.applied).toBe(true);

    const post = await h.session.executeOp(
      env({ type: 'fs.write', path: join(h.ws2, 'in-ws2.txt'), content: 'x', encoding: 'utf8' }, 'op-post'),
    );
    expect(post.ok).toBe(true); // 扩后即刻可写
  });

  it('idle 时 policy.update → applied=false（onPolicyUpdate 仍回调）', () => {
    const h = makeHarness();
    const out = h.session.policyUpdate({
      type: 'policy.update',
      policy: h.policy,
      direction: 'tighten',
    });
    expect(out.applied).toBe(false);
    expect(h.policyUpdates).toEqual([{ frame: expect.anything(), applied: false }]);
  });
});

// ── 确认超时（T1/T2 300s 默认拒）──────────────────────────────────────────

describe('MechaSession 确认超时', () => {
  it('T1 确认 300s 超时 → CONFIRM_TIMEOUT，迟到批准无效', async () => {
    vi.useFakeTimers();
    const h = makeHarness({ holdConfirm: true });
    h.acceptOffer();

    const r = h.session.executeOp(
      env({ type: 'fs.write', path: 't.txt', content: 'T', encoding: 'utf8' }, 'op-t'),
    );
    await vi.advanceTimersByTimeAsync(Mecha.MECHA_LIMITS_DEFAULTS.confirmTimeoutMs);

    const result = await r;
    expect(result.error?.code).toBe('CONFIRM_TIMEOUT');
    expect(fs.existsSync(join(h.realWs, 't.txt'))).toBe(false);

    // 迟到批准：race 已按超时结算，绝不放行
    h.releaseConfirm({ approved: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(fs.existsSync(join(h.realWs, 't.txt'))).toBe(false);
  });

  it('确认正常批准：timer 结算即清（无悬挂计时器），op 成功', async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    h.acceptOffer();

    const result = await h.session.executeOp(
      env({ type: 'fs.write', path: 'ok.txt', content: 'OK', encoding: 'utf8' }, 'op-ok'),
    );
    expect(result.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(0); // 确认计时器结算即清
  });
});

// ── op 串行（R15）─────────────────────────────────────────────────────────

describe('MechaSession op 串行', () => {
  it('ops 一次一个：前 op 未决时后 op 不进执行器，审计线性', async () => {
    const h = makeHarness({ holdConfirm: true });
    h.acceptOffer();

    const opA = h.session.executeOp(
      env({ type: 'fs.write', path: 'a.txt', content: 'A', encoding: 'utf8' }, 'op-a'),
    );
    await waitForCondition(() => h.confirm.mock.calls.length === 1, 'opA 确认已发出');

    const opB = h.session.executeOp(env({ type: 'fs.list', path: '.' }, 'op-b'));
    await new Promise((r) => setTimeout(r, 50)); // 若串行违规，opB 早已执行
    expect(h.logOp).not.toHaveBeenCalled(); // opA 未决、opB 未跑

    h.releaseConfirm({ approved: true });
    const [ra, rb] = await Promise.all([opA, opB]);
    expect(ra.ok).toBe(true);
    expect(rb.ok).toBe(true);
    expect(h.logOp.mock.calls.map((c) => (c[0] as Mecha.MechaOpEnvelope).opId)).toEqual([
      'op-a',
      'op-b',
    ]);
  });
});

// ── I1：op 信封 sessionId 绑定（final review）────────────────────────────

describe('MechaSession 信封 sessionId 绑定（I1）', () => {
  it('信封 sessionId 与在会不符 → IO_ERROR session mismatch、零执行、当前会话日志留拒收行', async () => {
    const h = makeHarness();
    h.acceptOffer();

    const r = await h.session.executeOp({
      opId: 'op-x',
      sessionId: 'sess-other',
      op: { type: 'fs.write', path: 'x.txt', content: 'X', encoding: 'utf8' },
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('IO_ERROR');
    expect(r.error?.message).toBe('session mismatch');
    // 不进执行流（无 op_request/op 审计行）、不进确认（零副作用）
    expect(h.logOp).not.toHaveBeenCalled();
    expect(h.confirm).not.toHaveBeenCalled();
    expect(fs.existsSync(join(h.realWs, 'x.txt'))).toBe(false);
    // 拒收留痕落在**当前**会话（信封 sessionId 无合法日志落点，锚不落）
    expect(h.logLifecycle).toHaveBeenCalledTimes(1);
    expect(h.logLifecycle).toHaveBeenCalledWith('op_rejected_session_mismatch', {
      opId: 'op-x',
      claimedSessionId: 'sess-other',
    });
  });

  it('终局后（idle）同会话信封照旧 no active session——绑定门不遮蔽 idle 诊断', async () => {
    const h = makeHarness();
    h.acceptOffer();
    h.session.disarm('completed');
    h.logLifecycle.mockClear();

    const r = await h.session.executeOp(
      env({ type: 'fs.list', path: '.' }, 'op-after'),
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe('no active session');
    expect(h.logLifecycle).not.toHaveBeenCalled();
  });

  it('本会话信封照常放行（绑定门不误伤合法 op）', async () => {
    const h = makeHarness();
    h.acceptOffer();
    const r = await h.session.executeOp(
      env({ type: 'fs.list', path: '.' }, 'op-ok'),
    );
    expect(r.ok).toBe(true);
    expect(h.logLifecycle).not.toHaveBeenCalled();
  });
});

// ── I3：T1 remember（spec §5.3 兑现，final review）───────────────────────

describe('MechaSession T1 remember（I3）', () => {
  it('exec T1 批准+记住 → 同程序再 exec 免确认且 ok；不同程序仍确认；T2 永不记忆', async () => {
    const h = makeHarness({ remember: true });
    h.acceptOffer();
    // fixture 直写脚本（不经驾驶 op → 不入溯源 → exec 判 T1）
    fs.writeFileSync(join(h.ws, 'a.js'), 'console.log("a");');

    const r1 = await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r1'),
    );
    expect(r1.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0]![0].tier).toBe('T1');

    // 同程序第二次 exec：免确认（无 confirmRequest）+ ok
    const r2 = await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r2'),
    );
    expect(r2.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.logLifecycle).toHaveBeenCalledWith('confirmed_remembered', {
      opId: 'op-r2',
      program: NODE.absPath,
    });

    // 不同程序 Y：不在记忆集 → 仍确认
    const yAbs = join(h.ws, process.platform === 'win32' ? 'y.cmd' : 'y.sh');
    fs.writeFileSync(yAbs, 'echo y\n');
    const tightened: Mecha.MechaPolicy = {
      ...h.policy,
      programs: [NODE, { name: 'y', absPath: yAbs }],
    };
    h.session.policyUpdate({ type: 'policy.update', policy: tightened, direction: 'tighten' });
    await h.session.executeOp(
      env({ type: 'exec.run', argv: ['y', 'arg'], cwd: '.' }, 'op-r3'),
    );
    expect(h.confirm).toHaveBeenCalledTimes(2);

    // T2（node -e 内联）永不命中记忆集：node 已记忆仍弹卡，且即便 remember
    // 批复也不会把 T2 写入记忆集
    const t2a = await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', '-e', 'console.log(1)'], cwd: '.' }, 'op-t2a'),
    );
    expect(t2a.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(3);
    expect(h.confirm.mock.calls[2]![0].tier).toBe('T2');
    const t2b = await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', '-e', 'console.log(2)'], cwd: '.' }, 'op-t2b'),
    );
    expect(t2b.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(4); // T2 每次都确认
  });

  it('T1 remember 不越权到 fs.*：fs.write 即便 remember 批复也不进记忆集（每写仍确认）', async () => {
    const h = makeHarness({ remember: true });
    h.acceptOffer();
    const w1 = await h.session.executeOp(
      env({ type: 'fs.write', path: 'w.txt', content: 'W', encoding: 'utf8' }, 'op-w1'),
    );
    expect(w1.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const w2 = await h.session.executeOp(
      env({ type: 'fs.write', path: 'w2.txt', content: 'W', encoding: 'utf8' }, 'op-w2'),
    );
    expect(w2.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(2); // 非 exec.run → 不记忆
  });

  it('NB-2：危险 env 键 → T2 红卡且卡面点名键名；remember 不越过 env 红卡；良性 env 照旧', async () => {
    const h = makeHarness({ remember: true });
    h.acceptOffer();
    fs.writeFileSync(join(h.ws, 'a.js'), 'console.log("a");');
    // 先记 node（T1 批准+记住，第二次免确认）
    await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r1'),
    );
    await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r2'),
    );
    expect(h.confirm).toHaveBeenCalledTimes(1);

    // 同程序 + 危险 env：remember 不越过 → 仍 T2 确认，卡面点名全部键 + 红卡披露语
    const r3 = await h.session.executeOp(
      env(
        {
          type: 'exec.run',
          argv: ['node', 'a.js'],
          cwd: '.',
          env: { NODE_OPTIONS: '--require ./evil.js', BASH_ENV: 'p.sh' },
        },
        'op-env',
      ),
    );
    expect(r3.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(2);
    const req3 = h.confirm.mock.calls[1]![0] as Mecha.MechaConfirmRequest;
    expect(req3.tier).toBe('T2');
    expect(req3.summary).toContain('环境变量含 NODE_OPTIONS、BASH_ENV');
    expect(req3.summary.startsWith('红卡警告：')).toBe(true);

    // 良性 env：不触发红卡——node 已记忆 → 照旧免确认放行
    const r4 = await h.session.executeOp(
      env(
        { type: 'exec.run', argv: ['node', 'a.js'], cwd: '.', env: { FOO: '1' } },
        'op-benv',
      ),
    );
    expect(r4.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(2); // 零新增确认
  });

  it('NB-4：终局收割后的迟到 remember 批复不入记忆集（stale-add 守卫）', async () => {
    const h = makeHarness({ holdConfirm: true });
    h.acceptOffer();
    fs.writeFileSync(join(h.ws, 'a.js'), 'console.log("a");');
    const pending = h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-s'),
    );
    await waitForCondition(() => h.confirm.mock.calls.length === 1, '确认已发出');
    h.session.disarm('completed'); // 终局收割（executor 置空）
    h.releaseConfirm({ approved: true, remember: true }); // 迟到的批复（stale）
    await new Promise((r) => setImmediate(r));

    // 新 offer 后同程序 exec：记忆集必须仍为空 → 重新弹卡（holdConfirm 需再放行）
    h.acceptOffer();
    h.confirm.mockClear();
    const r2p = h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-s2'),
    );
    await waitForCondition(() => h.confirm.mock.calls.length === 1, '新会话确认已发出');
    h.releaseConfirm({ approved: true });
    const r = await r2p;
    expect(r.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    await pending;
  });

  it('终局清记忆：新 offer 后同程序 exec 重新确认（集随会话生灭）', async () => {
    const h = makeHarness({ remember: true });
    h.acceptOffer();
    fs.writeFileSync(join(h.ws, 'a.js'), 'console.log("a");');
    await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r1'),
    );
    await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r2'),
    );
    expect(h.confirm).toHaveBeenCalledTimes(1);

    h.session.disarm('completed');
    h.acceptOffer(); // 新会话（同一 session 对象复用）
    h.confirm.mockClear();
    const r3 = await h.session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r3'),
    );
    expect(r3.ok).toBe(true);
    expect(h.confirm).toHaveBeenCalledTimes(1); // 记忆已清，重新弹卡
  });

  it('审计面（真 DashcamLogger）：remember 后日志恰一对 confirm + 一行 confirmed_remembered', async () => {
    const ws = makeWorkspace('mecha-session-remember-');
    const logsDir = join(ws, 'logs');
    const logger = new DashcamLogger(logsDir);
    const provenance = new ProvenanceStore(join(ws, 'provenance.json'));
    fs.writeFileSync(join(ws, 'a.js'), 'console.log("a");'); // fixture 直写 → 非溯源
    const confirm = vi.fn((req: Mecha.MechaConfirmRequest) => {
      const result = { requestId: req.requestId, approved: true, remember: true };
      // 桥接层（daemon）的批复入档职责替身：每个抵达此处的请求恰记一对
      logger.logConfirm(req, result);
      return Promise.resolve(result);
    });
    const session = new MechaSession({
      provenance,
      confirm,
      log: logger,
      logLifecycle: (event, detail) => logger.logLifecycle(event, detail),
    });
    session.on('attached', (m) => logger.beginSession(m.sessionId, m));
    session.on('ended', () => logger.endSession('completed'));
    const d = session.offer(
      offerFrame(
        { dirs: [ws], programs: [NODE], limits: { ...Mecha.MECHA_LIMITS_DEFAULTS } },
        'sess-1',
      ),
    );
    expect(d.decision).toBe('accept');

    const r1 = await session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r1'),
    );
    const r2 = await session.executeOp(
      env({ type: 'exec.run', argv: ['node', 'a.js'], cwd: '.' }, 'op-r2'),
    );
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(1);
    session.disarm('completed');

    const lines = fs
      .readFileSync(join(logsDir, 'sess-1.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const confirmLines = lines.filter((l) => l['kind'] === 'confirm');
    expect(confirmLines).toHaveLength(1); // 恰一对 confirm（第二次无卡可对）
    const remembered = lines.filter(
      (l) => l['kind'] === 'lifecycle' && l['event'] === 'confirmed_remembered',
    );
    expect(remembered).toHaveLength(1);
    expect(remembered[0]!['detail']).toEqual({
      opId: 'op-r2',
      program: NODE.absPath,
    });
  });
});
