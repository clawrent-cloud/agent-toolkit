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

    const opLine = lines.find((l) => l['kind'] === 'op');
    expect(opLine).toBeDefined();
    expect((opLine!['envelope'] as { opId: string }).opId).toBe('op-1');
    expect((opLine!['result'] as { ok: boolean }).ok).toBe(true);

    expect(lines[lines.length - 1]!['kind']).toBe('session_end');
    expect(lines[lines.length - 1]!['reason']).toBe('completed');
    // 顺序：开卷 → confirm → op → 合卷（逐行可读的审计时间线）
    expect(kinds.indexOf('confirm')).toBeGreaterThan(0);
    expect(kinds.indexOf('op')).toBeGreaterThan(kinds.indexOf('confirm'));
  }, 20_000);

  it('config.json 缺失 / 形状非法 → 响亮拒绝（提示请先运行 mecha setup）', async () => {
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
  });

  it('IPC status/halt 接线：idle → armed（含 sessionId/driverAgentId）→ halt 幂等终局', async () => {
    const profile = 'd16c';
    const home = makeHome(profile);
    const deliver = fs.mkdtempSync(join(tmpdir(), 'mecha-d16-ipc-'));
    created.push(deliver);
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

    // 行车记录：consumer_halt 生命周期行先于 session_end（合卷恒末行）
    const lines = readLogLines(join(home, 'logs', 'sess-d16c.jsonl'));
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
  }, 25_000);
});
