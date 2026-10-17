import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { MECHA_PACKAGE_VERSION } from './constants.js';
import { startDaemon } from './daemon.js';
import { ipcCall, safeIpcName } from './ipc.js';
import { realpathCanonical } from './enforcement/path-guard.js';
import type { DaemonHandle } from './daemon.js';
import { startMockRelay, waitFor, type MockRelay } from '../test/mock-relay.js';

// ── fixture 基建（os.tmpdir + 真实 127.0.0.1 socket，plan 全局约束）─────────

const created: string[] = [];
const daemons: DaemonHandle[] = [];
const relays: MockRelay[] = [];
const extraRelays: MockRelay[] = [];

function makeHome(profile: string): string {
  const dir = fs.mkdtempSync(join(tmpdir(), 'mecha-d16-home-'));
  created.push(dir);
  // config.json 形状 = T18 setup 落盘契约（deviceId/deviceToken/apiBase/profile）
  fs.writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      deviceId: `mecha-${profile}`,
      deviceToken: `tok-${profile}`,
      apiBase: 'https://api.clawrent.test',
      profile,
    }),
  );
  return dir;
}

function makePolicy(dirs: string[]): Mecha.MechaPolicy {
  return {
    dirs,
    programs: [{ name: 'node', absPath: process.execPath }],
    limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
  };
}

/** 行车记录 JSONL 读档（每行一个 JSON 对象）。 */
function readLogLines(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 路径比较基座：分隔符归一 + 小写（win32 tmpdir 的盘上大小写/8.3 形态漂移免疫）。 */
function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').toLowerCase();
}

afterEach(async () => {
  for (const daemon of daemons) await daemon.stop();
  daemons.length = 0;
  for (const relay of relays) await relay.close();
  relays.length = 0;
  for (const relay of extraRelays) await relay.close();
  extraRelays.length = 0;
});

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

/** 司机侧入站的分型收集（opResult / execChunk / confirmRequest 三族）。 */
interface DriverInbox {
  opResults: Mecha.MechaOpResult[];
  chunks: Mecha.MechaExecChunk[];
  confirms: Mecha.MechaConfirmRequest[];
}

function collectInbound(relay: MockRelay): DriverInbox {
  const inbox: DriverInbox = { opResults: [], chunks: [], confirms: [] };
  relay.driver.onMechaMessage((msg) => {
    if ('stream' in msg) inbox.chunks.push(msg);
    else if ('requestId' in msg) inbox.confirms.push(msg);
    else inbox.opResults.push(msg);
  });
  return inbox;
}

// ── 用例 ───────────────────────────────────────────────────────────────────

describe('startDaemon × mock relay（真 ws 全链总装）', () => {
  it('全链：offer → attach → fs.write 经确认批复 → opResult ok → session.end → 焚 scratch、交付物在、日志完整', async () => {
    const home = makeHome('d16a');
    const deliver = fs.mkdtempSync(join(tmpdir(), 'mecha-d16-deliver-'));
    created.push(deliver);
    const relay = await startMockRelay(0);
    relays.push(relay);
    const inbox = collectInbound(relay);

    const daemon = await startDaemon({
      configPath: join(home, 'config.json'),
      relayUrl: relay.url,
      homeOverride: home,
    });
    daemons.push(daemon);

    // 开机就绪：设备通道握手完成（hello 已到平台）
    await relay.driver.waitFor(() =>
      relay.frameLog.some((f) => f.type === 'device.hello') ? true : undefined,
    );

    // ① offer（tmpdir 白名单 + node 程序表）→ attach（accept 帧到达司机侧）
    relay.driver.offer(makePolicy([deliver]), 'sess-d16', 'driver-d16');
    const accept = await relay.driver.waitFor(() =>
      relay.frameLog.find(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-d16',
      ),
    );
    expect(accept.type).toBe('session.accept');

    // ② scratch 建立（首白名单目录下）
    const scratch = join(deliver, '.clawrent', 'scratch', 'sess-d16');
    expect(fs.existsSync(scratch)).toBe(true);

    // ②' T0 免确认 op（fs.list）：request + result 成对入档（R19 锚点）
    relay.driver.sendOp({
      opId: 'op-0',
      sessionId: 'sess-d16',
      op: { type: 'fs.list', path: '.', depth: 0 },
    });
    const r0 = await relay.driver.waitFor(() =>
      inbox.opResults.find((r) => r.opId === 'op-0'),
    );
    expect(r0.ok).toBe(true);

    // ③ 司机发 fs.write（T1）→ 机甲上行 confirmRequest → 司机代消费者批准
    relay.driver.sendOp({
      opId: 'op-1',
      sessionId: 'sess-d16',
      op: {
        type: 'fs.write',
        path: '交付物.txt',
        content: 'hello mecha',
        encoding: 'utf8',
      },
    });
    const confirm = await relay.driver.waitFor(() =>
      inbox.confirms.find((c) => c.opId === 'op-1'),
    );
    expect(confirm.tier).toBe('T1');
    expect(confirm.requestId).toBe('op-1:confirm');
    expect(confirm.summary).toContain('交付物');
    relay.driver.sendDown({ requestId: confirm.requestId, approved: true });

    // ④ opResult ok → 交付物落盘
    const result = await relay.driver.waitFor(() =>
      inbox.opResults.find((r) => r.opId === 'op-1'),
    );
    expect(result.ok).toBe(true);
    const deliverable = join(deliver, '交付物.txt');
    expect(fs.readFileSync(deliverable, 'utf8')).toBe('hello mecha');

    // ⑤ session.end（completed）→ 终局 ack（第二条 accept）→ 即焚 + 交付物幸存
    relay.driver.end('completed');
    await relay.driver.waitFor(() =>
      relay.frameLog.filter(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-d16',
      ).length >= 2
        ? true
        : undefined,
    );
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.existsSync(deliverable)).toBe(true);

    // ⑥ 溯源表登记（daemon 级单 ProvenanceStore 接线证据）。登记口径 =
    // path-guard 的真实形（realpathCanonical）——win32 上 os.tmpdir() 的 8.3
    // 短名（PINKBA~1）会被展开为盘上长名，故期望值按同一真实化口径求取。
    const canonicalDeliverable = realpathCanonical(deliverable);
    const prov = JSON.parse(
      fs.readFileSync(join(home, 'provenance.json'), 'utf8'),
    ) as { entries: Array<{ path: string }> };
    expect(
      prov.entries.some((e) => normPath(e.path) === normPath(canonicalDeliverable)),
    ).toBe(true);

    // ⑦ 行车记录完整：session_begin（manifest 全量）/ confirm / op / session_end
    const logFile = join(home, 'logs', 'sess-d16.jsonl');
    const lines = await waitFor(() => {
      const parsed = readLogLines(logFile);
      const last = parsed[parsed.length - 1];
      return last !== undefined && last['kind'] === 'session_end'
        ? parsed
        : undefined;
    });
    const kinds = lines.map((l) => l['kind']);
    expect(kinds[0]).toBe('session_begin');
    const manifest = lines[0]!['manifest'] as Mecha.CapabilityManifest;
    expect(manifest.sessionId).toBe('sess-d16');
    expect(manifest.policy.dirs[0]).toBe(deliver);
    expect(manifest.mechaVersion).toBe(MECHA_PACKAGE_VERSION);
    expect(manifest.scratchDir).toBe(scratch);

    const confirmLine = lines.find((l) => l['kind'] === 'confirm');
    expect(confirmLine).toBeDefined();
    expect((confirmLine!['request'] as { requestId: string }).requestId).toBe(
      'op-1:confirm',
    );
    expect((confirmLine!['result'] as { approved: boolean }).approved).toBe(
      true,
    );

    const opLine = lines.find(
      (l) =>
        l['kind'] === 'op' &&
        (l['envelope'] as { opId: string }).opId === 'op-1',
    );
    expect(opLine).toBeDefined();
    expect((opLine!['result'] as { ok: boolean }).ok).toBe(true);

    // R19 锚点（「任何被考虑执行的 op 至少留一行」）：T0 免确认 op 同样
    // request+result 成对，request 恒在 result 之前（文件序 = 审计时间线）；
    // T1 op 的 request 先于其 confirm 行（判级前落锚、确认后执行）
    const lineIndex = (kind: string, opId: string): number =>
      lines.findIndex(
        (l) =>
          l['kind'] === kind &&
          (l['envelope'] as { opId: string }).opId === opId,
      );
    const req0 = lineIndex('op_request', 'op-0');
    const res0 = lineIndex('op', 'op-0');
    const req1 = lineIndex('op_request', 'op-1');
    expect(req0).toBeGreaterThan(0); // 开卷之后
    expect(res0).toBeGreaterThan(req0);
    expect(req1).toBeGreaterThan(res0);
    expect(kinds.indexOf('confirm')).toBeGreaterThan(req1);
    expect(lineIndex('op', 'op-1')).toBeGreaterThan(kinds.indexOf('confirm'));

    expect(lines[lines.length - 1]!['kind']).toBe('session_end');
    expect(lines[lines.length - 1]!['reason']).toBe('completed');
  }, 20_000);

  it('config.json 缺失 / 形状非法 / apiBase 协议非法 → 响亮拒绝', async () => {
    const home = makeHome('d16b');
    await expect(
      startDaemon({
        configPath: join(home, 'no-such-config.json'),
        relayUrl: 'ws://127.0.0.1:1',
        homeOverride: home,
      }),
    ).rejects.toThrow('请先运行 mecha setup');

    fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ deviceId: 'x' }));
    await expect(
      startDaemon({
        configPath: join(home, 'config.json'),
        relayUrl: 'ws://127.0.0.1:1',
        homeOverride: home,
      }),
    ).rejects.toThrow(/deviceToken/);

    // apiBase 协议门（T16 fix Minor）：非 http(s) 一律开机即拒——否则非法
    // ws 地址让首拨抛错、重连链死亡（一次 warn 后静默空转）
    const writeConfig = (apiBase: string): void => {
      fs.writeFileSync(
        join(home, 'config.json'),
        JSON.stringify({
          deviceId: 'x',
          deviceToken: 't',
          apiBase,
          profile: 'd16b',
        }),
      );
    };
    writeConfig('ftp://api.example.com');
    await expect(
      startDaemon({
        configPath: join(home, 'config.json'),
        relayUrl: 'ws://127.0.0.1:1',
        homeOverride: home,
      }),
    ).rejects.toThrow(/apiBase/);
    writeConfig('api.clawrent.cloud'); // 无协议
    await expect(
      startDaemon({
        configPath: join(home, 'config.json'),
        relayUrl: 'ws://127.0.0.1:1',
        homeOverride: home,
      }),
    ).rejects.toThrow(/apiBase/);

    // relayUrl 覆盖同闸：设备通道地址非 ws(s) 也拒
    writeConfig('https://api.clawrent.test');
    await expect(
      startDaemon({
        configPath: join(home, 'config.json'),
        relayUrl: 'ftp://127.0.0.1:1',
        homeOverride: home,
      }),
    ).rejects.toThrow(/ws\(s\)/);
  });

  it('confirm 超时收割审计归真：timeout 结算对入档、迟到批复不写假账、表项摘除', async () => {
    const home = makeHome('d16f');
    const deliver = fs.mkdtempSync(join(tmpdir(), 'mecha-d16-timeout-'));
    created.push(deliver);
    const relay = await startMockRelay(0);
    relays.push(relay);
    const inbox = collectInbound(relay);
    const daemon = await startDaemon({
      configPath: join(home, 'config.json'),
      relayUrl: relay.url,
      homeOverride: home,
    });
    daemons.push(daemon);
    await relay.driver.waitFor(() =>
      relay.frameLog.some((f) => f.type === 'device.hello') ? true : undefined,
    );

    // 短确认超时策略（等效 fake timers 推进 300s：真实 socket 套件纪律——
    // 状态等待一律 poll，超时窗口经 policy.limits.confirmTimeoutMs 注入）
    const policy = makePolicy([deliver]);
    policy.limits = { ...policy.limits, confirmTimeoutMs: 150 };
    relay.driver.offer(policy, 'sess-d16f', 'driver-d16f');
    await relay.driver.waitFor(() =>
      relay.frameLog.some(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-d16f',
      ),
    );

    relay.driver.sendOp({
      opId: 'op-t',
      sessionId: 'sess-d16f',
      op: {
        type: 'fs.write',
        path: 'never.txt',
        content: 'x',
        encoding: 'utf8',
      },
    });
    const confirm = await relay.driver.waitFor(() =>
      inbox.confirms.find((c) => c.opId === 'op-t'),
    );

    // 不批复——会话超时收割：CONFIRM_TIMEOUT 结果、文件未写
    const result = await relay.driver.waitFor(() =>
      inbox.opResults.find((r) => r.opId === 'op-t'),
    );
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe(Mecha.MECHA_ERROR_CODES[3]); // CONFIRM_TIMEOUT
    expect(fs.existsSync(join(deliver, 'never.txt'))).toBe(false);

    // 迟到批复：桥表项已被收割摘除——不写假 approved 账、不炸链路。
    // end 帧与批复同 ws 有序（批复先处理），session_end 成行即批复已消化。
    relay.driver.sendDown({ requestId: confirm.requestId, approved: true });
    relay.driver.end('completed');
    const lines = await waitFor(() => {
      const parsed = readLogLines(join(home, 'logs', 'sess-d16f.jsonl'));
      const last = parsed[parsed.length - 1];
      return last !== undefined && last['kind'] === 'session_end'
        ? parsed
        : undefined;
    });

    // 恰一对结算（timeout）——假 approved 第二笔不存在（表项摘除的证据）
    const confirmLines = lines.filter((l) => l['kind'] === 'confirm');
    expect(confirmLines).toHaveLength(1);
    expect(confirmLines[0]!['request']).toMatchObject({
      requestId: 'op-t:confirm',
    });
    expect(confirmLines[0]!['result']).toMatchObject({
      approved: false,
      confirmEnd: 'timeout',
    });
    expect(lines[lines.length - 1]).toMatchObject({
      kind: 'session_end',
      reason: 'completed',
    });
  }, 20_000);

  it('IPC status/halt 接线：idle → armed（含 sessionId/driverAgentId）→ halt 幂等终局', async () => {
    const profile = 'd16c';
    const home = makeHome(profile);
    const deliver = fs.mkdtempSync(join(tmpdir(), 'mecha-d16-ipc-'));
    created.push(deliver);
    const relay = await startMockRelay(0);
    relays.push(relay);
    const inbox = collectInbound(relay);
    const daemon = await startDaemon({
      configPath: join(home, 'config.json'),
      relayUrl: relay.url,
      homeOverride: home,
    });
    daemons.push(daemon);
    await relay.driver.waitFor(() =>
      relay.frameLog.some((f) => f.type === 'device.hello') ? true : undefined,
    );

    const pipe = safeIpcName(profile);
    const idle = await ipcCall(pipe, 'status');
    expect(idle.ok).toBe(true);
    if (idle.ok) {
      expect(idle.state).toBe('idle');
      expect(idle.sessionId).toBeUndefined();
      expect(typeof idle.since).toBe('number');
    }

    // offer → armed（status 镜像会话态 + 司机 id）
    relay.driver.offer(makePolicy([deliver]), 'sess-d16c', 'driver-d16c');
    await relay.driver.waitFor(() =>
      relay.frameLog.some(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-d16c',
      ),
    );
    const armed = await ipcCall(pipe, 'status');
    expect(armed.ok).toBe(true);
    if (armed.ok) {
      expect(armed.state).toBe('armed');
      expect(armed.sessionId).toBe('sess-d16c');
      expect(armed.driverAgentId).toBe('driver-d16c');
    }

    // 独占 A7：在会第二 offer → reject 'busy'
    relay.driver.offer(makePolicy([deliver]), 'sess-other', 'driver-2');
    const busy = await relay.driver.waitFor(() =>
      relay.frameLog.find(
        (f) => f.type === 'session.reject' && f.reason === 'busy',
      ),
    );
    expect(busy.type).toBe('session.reject');

    // 在途确认遇 halt：终局收割（'ended' 真实结算对入档）——先等确认请求
    // 抵达司机侧（= 桥表项已在），再刹车，时序确定
    relay.driver.sendOp({
      opId: 'op-h',
      sessionId: 'sess-d16c',
      op: {
        type: 'fs.write',
        path: 'halted.txt',
        content: 'x',
        encoding: 'utf8',
      },
    });
    await relay.driver.waitFor(() =>
      inbox.confirms.find((c) => c.opId === 'op-h'),
    );

    // halt → 幂等终局（杀 exec + 焚 scratch + 合卷）→ status 回 idle
    const halted = await ipcCall(pipe, 'halt');
    expect(halted).toEqual({ ok: true });
    const afterHalt = await ipcCall(pipe, 'status');
    expect(afterHalt.ok).toBe(true);
    if (afterHalt.ok) {
      expect(afterHalt.state).toBe('idle');
      expect(afterHalt.sessionId).toBeUndefined();
    }
    expect(fs.existsSync(join(deliver, '.clawrent', 'scratch', 'sess-d16c'))).toBe(
      false,
    );

    // 行车记录：在途确认的真实结算对（confirmEnd 'ended'）+ consumer_halt
    // 生命周期行先于 session_end（合卷恒末行）。
    // R19 锚点不变量：被终局收割的在途 op 仍留 op_request 行（「任何被考虑
    // 执行的 op 至少一行」）；无对应 result 行——由 session_end 行解释结局
    //（request 行落于 fd 未关时——op 一经派发即落锚；result 续延晚于合卷，
    // fail-loud 被 executor 尽力而为吞错吸收，行为维持现状）。
    const lines = readLogLines(join(home, 'logs', 'sess-d16c.jsonl'));
    const confirmLine = lines.find((l) => l['kind'] === 'confirm');
    expect(confirmLine).toBeDefined();
    expect(confirmLine!['request']).toMatchObject({ requestId: 'op-h:confirm' });
    expect(confirmLine!['result']).toMatchObject({
      approved: false,
      confirmEnd: 'ended',
    });
    const lineByOp = (kind: string, opId: string): Record<string, unknown> | undefined =>
      lines.find(
        (l) =>
          l['kind'] === kind &&
          (l['envelope'] as { opId: string }).opId === opId,
      );
    expect(lineByOp('op_request', 'op-h')).toBeDefined();
    expect(lineByOp('op', 'op-h')).toBeUndefined();
    const haltIdx = lines.findIndex(
      (l) => l['kind'] === 'lifecycle' && l['event'] === 'consumer_halt',
    );
    expect(haltIdx).toBeGreaterThan(0);
    expect(lines[lines.length - 1]).toMatchObject({
      kind: 'session_end',
      reason: 'consumer_halt',
    });

    // 再 halt：幂等（无会话即无事可刹），响应照常
    const haltedAgain = await ipcCall(pipe, 'halt');
    expect(haltedAgain).toEqual({ ok: true });
  }, 20_000);

  it('policy.update 接线：tighten 受理并落账；idle 拒绝回复且不炸审计闸（T13 守卫）', async () => {
    const profile = 'd16d';
    const home = makeHome(profile);
    const deliver = fs.mkdtempSync(join(tmpdir(), 'mecha-d16-policy-'));
    created.push(deliver);
    const extra = fs.mkdtempSync(join(tmpdir(), 'mecha-d16-policy2-'));
    created.push(extra);
    const relay = await startMockRelay(0);
    relays.push(relay);
    const daemon = await startDaemon({
      configPath: join(home, 'config.json'),
      relayUrl: relay.url,
      homeOverride: home,
    });
    daemons.push(daemon);
    await relay.driver.waitFor(() =>
      relay.frameLog.some((f) => f.type === 'device.hello') ? true : undefined,
    );

    const base = makePolicy([deliver]);
    relay.driver.offer(base, 'sess-d16d', 'driver-d16d');
    await relay.driver.waitFor(() =>
      relay.frameLog.some(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-d16d',
      ),
    );

    // tighten（追加白名单目录）→ accept 回执 + 行车记录 policy_update applied:true
    relay.driver.policyUpdate({
      type: 'policy.update',
      policy: { ...base, dirs: [deliver, extra] },
      direction: 'tighten',
    });
    await relay.driver.waitFor(() =>
      relay.frameLog.filter(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-d16d',
      ).length >= 2
        ? true
        : undefined,
    );
    const lines = readLogLines(join(home, 'logs', 'sess-d16d.jsonl'));
    const updates = lines.filter((l) => l['kind'] === 'policy_update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ applied: true });

    // 终局后再来 policy.update → reject 'no active session'；审计闸不炸
    //（T13 守卫：idle 不落账——否则 logger 抛错）
    relay.driver.end('completed');
    await relay.driver.waitFor(() => {
      const parsed = readLogLines(join(home, 'logs', 'sess-d16d.jsonl'));
      const last = parsed[parsed.length - 1];
      return last !== undefined && last['kind'] === 'session_end' ? true : undefined;
    });
    relay.driver.policyUpdate({
      type: 'policy.update',
      policy: base,
      direction: 'tighten',
    });
    const rejected = await relay.driver.waitFor(() =>
      relay.frameLog.find(
        (f) => f.type === 'session.reject' && f.reason === 'no active session',
      ),
    );
    expect(rejected.type).toBe('session.reject');
    // 空闲期的 policy.update 不落账（记账行仍只有会话内那一笔）
    const linesAfter = readLogLines(join(home, 'logs', 'sess-d16d.jsonl'));
    expect(
      linesAfter.filter((l) => l['kind'] === 'policy_update'),
    ).toHaveLength(1);
  }, 20_000);

  it('断链/重连接线：失电杀会话保护 + link_down 落账 → 恢复 resumed 落账、会话幸存', async () => {
    const profile = 'd16e';
    const home = makeHome(profile);
    const deliver = fs.mkdtempSync(join(tmpdir(), 'mecha-d16-link-'));
    created.push(deliver);
    const relay = await startMockRelay(0);
    relays.push(relay);
    const inbox = collectInbound(relay);
    const daemon = await startDaemon({
      configPath: join(home, 'config.json'),
      relayUrl: relay.url,
      homeOverride: home,
    });
    daemons.push(daemon);
    await relay.driver.waitFor(() =>
      relay.frameLog.some((f) => f.type === 'device.hello') ? true : undefined,
    );

    relay.driver.offer(makePolicy([deliver]), 'sess-d16e', 'driver-d16e');
    await relay.driver.waitFor(() =>
      relay.frameLog.some(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-d16e',
      ),
    );
    const logFile = join(home, 'logs', 'sess-d16e.jsonl');

    // 在途确认遇断链：失电收割（'link_down' 真实结算对入档）——先等确认
    // 请求抵达司机侧（= 桥表项已在），再杀链路，时序确定
    relay.driver.sendOp({
      opId: 'op-l',
      sessionId: 'sess-d16e',
      op: {
        type: 'fs.write',
        path: 'dropped.txt',
        content: 'x',
        encoding: 'utf8',
      },
    });
    await relay.driver.waitFor(() =>
      inbox.confirms.find((c) => c.opId === 'op-l'),
    );

    // 杀链路 → 失电（宽限计时默认 60s，会话幸存）→ link_down 落账
    const port = Number(new URL(relay.url).port);
    await relay.close();
    await waitFor(() => {
      const parsed = readLogLines(logFile);
      return parsed.some(
        (l) => l['kind'] === 'lifecycle' && l['event'] === 'link_down',
      )
        ? true
        : undefined;
    }, 5_000);

    // 同端口重启 → 自动重连 → markLinkUp 'resumed' 落账
    const relay2 = await startMockRelay(port);
    extraRelays.push(relay2);
    await waitFor(() => {
      const parsed = readLogLines(logFile);
      return parsed.some(
        (l) => l['kind'] === 'lifecycle' && l['event'] === 'resumed',
      )
        ? true
        : undefined;
    }, 10_000);

    // 会话在宽限内幸存：status 仍 armed
    const status = await ipcCall(safeIpcName(profile), 'status');
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.state).toBe('armed');
      expect(status.sessionId).toBe('sess-d16e');
    }

    // 审计归真：断链收割的确认结算对（confirmEnd 'link_down'——批复未到，
    // 结算通知即事实唯一来源）
    const lines = readLogLines(logFile);
    const confirmLine = lines.find((l) => l['kind'] === 'confirm');
    expect(confirmLine).toBeDefined();
    expect(confirmLine!['request']).toMatchObject({ requestId: 'op-l:confirm' });
    expect(confirmLine!['result']).toMatchObject({
      approved: false,
      confirmEnd: 'link_down',
    });

    // R19 锚点 + 结果成对：request 行断链前已落（派发即落锚）；result 行随
    // 收割结算落盘（会话幸存、fd 未关——executor 面 link_down 口径 IO_ERROR）
    const lineByOp = (
      kind: string,
      opId: string,
    ): Record<string, unknown> | undefined =>
      lines.find(
        (l) =>
          l['kind'] === kind &&
          (l['envelope'] as { opId: string }).opId === opId,
      );
    const reqL = lineByOp('op_request', 'op-l');
    const resL = lineByOp('op', 'op-l');
    expect(reqL).toBeDefined();
    expect(resL).toBeDefined();
    expect(lines.indexOf(resL!)).toBeGreaterThan(lines.indexOf(reqL!));
    expect(resL!['result']).toMatchObject({
      ok: false,
      error: { code: Mecha.MECHA_ERROR_CODES[6] }, // IO_ERROR
    });
  }, 25_000);
});
