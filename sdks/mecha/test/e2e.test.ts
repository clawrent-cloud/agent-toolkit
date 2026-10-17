import { afterAll, afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { MechaDriver } from '@clawrent/provider';
import { MECHA_PACKAGE_VERSION } from '../src/constants.js';
import { startDaemon, type DaemonHandle } from '../src/daemon.js';
import { ipcCall, safeIpcName } from '../src/ipc.js';
import { realpathCanonical } from '../src/enforcement/path-guard.js';
import { startMockRelay, waitFor, type MockRelay } from './mock-relay.js';
import { createDriverBridge, type DriverBridge } from './driver-bridge.js';

/**
 * 端到端场景套件（plan Task 24；spec §13 的 toolkit 可测子集）。
 *
 * 全链真组件：startDaemon（device-client + session + executor + 行车记录 +
 * IPC 总装）× mock relay（真 127.0.0.1 ws，Task 14）× provider MechaDriver
 * （真驾驶 SDK，Task 21）——唯一 mock 面是「网络中继 + 平台角色」（mock
 * relay / driver-bridge）与「人批确认的手」（driver.approve/deny）。无业务
 * 逻辑替身：确认判级、白名单、溯源、即焚、失电全部是真实部件行为。
 *
 * 计费口径（plan 钉死）：mock relay frameLog 记录的机甲上行生命周期帧序列
 * （hello / attach / pause / resume / end 的 accept 回执）即断言数据源。
 *
 * 场景 → 用例映射：
 *  ①「完整打车流程」= test 1（含 ②交付物在、scratch 焚——plan 允许并入）；
 *  ③「断链中途」= test 2（宽限内重连）+ test 3（超宽限自动终局）；
 *  ④「跨会话马甲」= test 4；⑤「假 python.bat」= test 5；⑥「halt」= test 6。
 *
 * 等待纪律：真实 socket 套件一律 poll（waitFor / 日志轮询 / 进程存活探针），
 * 绝不真实 sleep；唯一例外是 racePending 的 200ms 负断言观察窗（证明「持续
 * 未收口」需要有界等待）；长时标经 policy.limits（disconnectGraceMs）注入。
 */

// ── fixture 基建（os.tmpdir 隔离 + 唯一 profile → win32 管道名互不冲突）─────

const created: string[] = [];
const daemons: DaemonHandle[] = [];
const relays: MockRelay[] = [];

function makeHome(profile: string): { home: string; configPath: string } {
  const home = fs.mkdtempSync(join(tmpdir(), 'mecha-e2e-home-'));
  created.push(home);
  const configPath = join(home, 'config.json');
  // config.json 形状 = T18 setup 落盘契约（deviceId/deviceToken/apiBase/profile）
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      deviceId: `mecha-${profile}`,
      deviceToken: `tok-${profile}`,
      apiBase: 'https://api.clawrent.test',
      profile,
    }),
  );
  return { home, configPath };
}

function makePolicy(dirs: string[]): Mecha.MechaPolicy {
  return {
    dirs,
    programs: [{ name: 'node', absPath: process.execPath }],
    limits: { ...Mecha.MECHA_LIMITS_DEFAULTS },
  };
}

/** 路径比较基座：分隔符归一 + 小写（win32 tmpdir 的盘上大小写/8.3 漂移免疫）。 */
function normPath(p: string): string {
  return p.replace(/[\\/]+/g, '/').toLowerCase();
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

function logByOp(
  lines: Array<Record<string, unknown>>,
  kind: string,
  opId: string,
): Record<string, unknown> | undefined {
  return lines.find(
    (l) =>
      l['kind'] === kind &&
      (l['envelope'] as { opId?: string } | undefined)?.opId === opId,
  );
}

interface Stack {
  home: string;
  deliver: string;
  relay: MockRelay;
  daemon: DaemonHandle;
  bridge: DriverBridge;
  driver: MechaDriver;
  manifests: Mecha.CapabilityManifest[];
  /** 确认处置模式（scenario 4 需要会话 2 改人拒）：approve | deny。 */
  confirmMode: 'approve' | 'deny';
  confirms: Mecha.MechaConfirmRequest[];
}

/** 起一台中继 + 一个真 daemon + 桥 + 真 MechaDriver，等待设备通道就绪
 * （device.hello 落 frameLog）。unique profile 供 IPC 端点名隔离。确认回路
 * 默认全自动批准（confirmMode 可按用例切人拒——scenario ④）。 */
async function startStack(profile: string): Promise<Stack> {
  const { home, configPath } = makeHome(profile);
  const deliver = fs.mkdtempSync(join(tmpdir(), `mecha-e2e-${profile}-`));
  created.push(deliver);
  const relay = await startMockRelay(0);
  relays.push(relay);
  const daemon = await startDaemon({
    configPath,
    relayUrl: relay.url,
    homeOverride: home, // R17：logs/ 与 provenance.json 全部落 tmp，不碰真 home
  });
  daemons.push(daemon);
  await relay.driver.waitFor(() =>
    relay.frameLog.some((f) => f.type === 'device.hello') ? true : undefined,
  );

  const bridge = createDriverBridge();
  bridge.attachTo(relay);
  const driver = new MechaDriver({ channel: bridge.channel, agentId: `agent-${profile}` });
  const manifests: Mecha.CapabilityManifest[] = [];
  driver.on('attached', (m) => manifests.push(m));

  const stack: Stack = {
    home,
    deliver,
    relay,
    daemon,
    bridge,
    driver,
    manifests,
    confirmMode: 'approve',
    confirms: [],
  };
  driver.onConfirmRequest((req) => {
    stack.confirms.push(req);
    if (stack.confirmMode === 'approve') driver.approve(req.requestId);
    else driver.deny(req.requestId);
  });
  return stack;
}

/** offer → 等 attach（manifest 到达驱动侧 + accept 落 frameLog）。 */
async function offerAndAttach(
  stack: Stack,
  policy: Mecha.MechaPolicy,
  sessionId: string,
): Promise<Mecha.CapabilityManifest> {
  stack.relay.driver.offer(policy, sessionId, `driver-${sessionId}`);
  return waitFor(() =>
    stack.manifests.find((m) => m.sessionId === sessionId),
  );
}

/** 进程存活探针（kill(pid,0)：活=不抛，死=抛 ESRCH）。 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** resolve-or-pending 探针（200ms 真实观察窗，T24 review 裁定）：'settled' =
 * promise 在窗内收口；'pending' = 窗口耗尽仍未收口（哑管道悬置断言）。
 * 旧实现第二臂 `Promise.resolve('pending')` 即决——只证明「此刻未收口」，
 * 窗是假的；有界窗才真正钉住「持续悬置」。 */
function racePending(p: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    p.then(() => 'settled' as const),
    new Promise((resolve) => setTimeout(resolve, 200)).then(
      () => 'pending' as const,
    ),
  ]);
}

/** 永驻脚本：落 PID 标记后靠 interval 保活（exec 被杀 = PID 探针转死）。 */
const KEEPALIVE_SCRIPT =
  "require('node:fs').writeFileSync(process.argv[2], String(process.pid));setInterval(()=>{},1000);";

afterEach(async () => {
  for (const daemon of daemons) await daemon.stop();
  daemons.length = 0;
  for (const relay of relays) await relay.close();
  relays.length = 0;
});

afterAll(() => {
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
});

// ── 场景 ───────────────────────────────────────────────────────────────────

describe('mecha 端到端（真 daemon × mock relay × 真 MechaDriver）', () => {
  it('①+② 完整打车流程：offer→attach→fsList(T0)→fsWrite(T1 批)→upload(T1 批)→exec(T2 红卡批，流块回传)→pause/resume→end；计费帧序、交付物在、scratch 焚、溯源含 upload+write', async () => {
    const stack = await startStack('ride');
    const { relay, driver, deliver, home } = stack;
    const policy = makePolicy([deliver]);

    // offer → attach（驱动侧 manifest + frameLog attach 帧同源）
    const manifest = await offerAndAttach(stack, policy, 'sess-ride');
    expect(manifest.sessionId).toBe('sess-ride');
    expect(manifest.policy.dirs[0]).toBe(deliver);
    expect(manifest.mechaVersion).toBe(MECHA_PACKAGE_VERSION);
    expect(manifest.scratchDir).toBe(
      join(deliver, '.clawrent', 'scratch', 'sess-ride'),
    );
    expect(fs.existsSync(manifest.scratchDir)).toBe(true);

    // T0 免确认：fs.list 直达（无确认弹窗）。条目 path = path-guard 真实形
    // （win32 tmpdir 8.3 短名展开），期望值按同一真实化口径求取
    const list = await driver.fsList('.', { depth: 0 });
    expect(list.ok).toBe(true);
    const entries = list.value as Array<{ path: string; name: string; kind: string }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe('.clawrent');
    expect(entries[0]!.kind).toBe('dir');
    expect(normPath(entries[0]!.path)).toBe(
      normPath(realpathCanonical(join(deliver, '.clawrent'))),
    );
    expect(stack.confirms).toHaveLength(0);

    // T1 经确认：fs.write → confirmRequest 到达驱动 → 批 → 落盘
    const w = await driver.fsWrite('交付物.txt', 'hello mecha', 'utf8');
    expect(w.ok).toBe(true);
    expect(w.tier).toBe('T1');
    expect(fs.readFileSync(join(deliver, '交付物.txt'), 'utf8')).toBe(
      'hello mecha',
    );
    const writeConfirm = stack.confirms.find((c) => c.opId === w.opId);
    expect(writeConfirm?.tier).toBe('T1');
    expect(writeConfirm?.summary).toContain('交付物');

    // upload 整理脚本（T1 批）→ 落会话暂存区（即焚区，溯源 T1 条目）
    const up = await driver.upload(
      'tidy.js',
      "require('node:fs').writeFileSync(process.argv[2],'tidied-by-mecha');console.log('tidy-ok');",
    );
    expect(up.ok).toBe(true);
    expect(up.tier).toBe('T1');
    const scriptPath = (up.value as { path: string }).path;
    expect(normPath(scriptPath)).toContain(
      normPath(
        realpathCanonical(join(deliver, '.clawrent', 'scratch', 'sess-ride')),
      ),
    );

    // exec 脚本（T2 红卡：溯源判红跨 op）→ 红卡披露语前置 → 批 → 真跑、
    // 产物落白名单、流块经真实链路回流（R23：注册先于 await）
    const reportPath = join(deliver, 'report.txt');
    const execP = driver.exec({
      argv: ['node', scriptPath, reportPath],
      cwd: deliver,
    });
    const chunks: Mecha.MechaExecChunk[] = [];
    driver.onExecChunk(execP.opId, (c) => chunks.push(c));
    const x = await execP;
    expect(x.ok).toBe(true);
    expect(x.tier).toBe('T2');
    const execConfirm = stack.confirms.find((c) => c.opId === execP.opId);
    expect(execConfirm?.tier).toBe('T2');
    expect(execConfirm?.summary.startsWith('红卡警告：')).toBe(true);
    expect(execConfirm?.summary).toContain('node');
    expect(chunks.some((c) => c.stream === 'stdout' && c.data.includes('tidy-ok'))).toBe(true);
    expect(fs.readFileSync(reportPath, 'utf8')).toBe('tidied-by-mecha');

    // pause → resume → end（驾驶员侧生命周期；机甲受理回执上行 = 计费帧）
    relay.driver.pause();
    await waitFor(() =>
      relay.frameLog.filter(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-ride',
      ).length >= 2
        ? true
        : undefined,
    );
    relay.driver.resume();
    await waitFor(() =>
      relay.frameLog.filter(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-ride',
      ).length >= 3
        ? true
        : undefined,
    );
    relay.driver.end('completed');
    await waitFor(() => {
      const lines = readLogLines(join(home, 'logs', 'sess-ride.jsonl'));
      const last = lines[lines.length - 1];
      return last !== undefined && last['kind'] === 'session_end' ? true : undefined;
    });

    // 计费口径断言：frameLog 生命周期帧序 = hello → accept(attach) →
    // accept(pause) → accept(resume) → accept(end)，全程无 reject
    const lifecycle = relay.frameLog.filter(
      (f) =>
        f.type === 'device.hello' ||
        f.type === 'session.accept' ||
        f.type === 'session.reject',
    );
    expect(lifecycle.map((f) => f.type)).toEqual([
      'device.hello',
      'session.accept',
      'session.accept',
      'session.accept',
      'session.accept',
    ]);
    for (const frame of lifecycle.slice(1)) {
      expect(frame).toMatchObject({ sessionId: 'sess-ride' });
    }

    // ② 交付物在、scratch 焚（终局即焚不碰白名单交付物）
    const scratch = join(deliver, '.clawrent', 'scratch', 'sess-ride');
    expect(fs.existsSync(scratch)).toBe(false);
    expect(fs.existsSync(join(deliver, '交付物.txt'))).toBe(true);
    expect(fs.existsSync(reportPath)).toBe(true);

    // 溯源含 upload 与 write 条目（登记键 = path-guard 真实形；upload 条目
    // 直接比对 op 返回的 value.path——它已是 executor 的真实化产物，且脚本
    // 本体已随终局焚毁，事后 realpath 会 ENOENT）
    const prov = JSON.parse(
      fs.readFileSync(join(home, 'provenance.json'), 'utf8'),
    ) as { entries: Array<{ path: string }> };
    const paths = prov.entries.map((e) => normPath(e.path));
    expect(paths).toContain(normPath(realpathCanonical(join(deliver, '交付物.txt'))));
    expect(paths).toContain(normPath(scriptPath));

    // 行车记录开卷 = attach manifest 全量（会话策略快照）
    const lines = readLogLines(join(home, 'logs', 'sess-ride.jsonl'));
    expect(lines[0]).toMatchObject({ kind: 'session_begin' });
    expect(lines[0]!['manifest']).toMatchObject({ sessionId: 'sess-ride' });
    expect((lines[lines.length - 1]!['reason'] as string)).toBe('completed');
  }, 30_000);

  it('③a 断链中途：exec 长跑被失电收割（进程死）、断链期新 op 不执行不排队不重放、宽限内同端口重启→resumed、后续 op 复跑', async () => {
    const stack = await startStack('link');
    const { relay, driver, deliver, home, bridge } = stack;
    const policy = makePolicy([deliver]);
    // 宽限 > 重连窗口（断链后首拨在 1s 退避后），留足 poll 余量
    policy.limits = { ...policy.limits, disconnectGraceMs: 10_000 };
    await offerAndAttach(stack, policy, 'sess-link');
    const logFile = join(home, 'logs', 'sess-link.jsonl');

    // 长跑 exec（T2 红卡批）→ 真 PID 落盘
    const up = await driver.upload('keepalive.js', KEEPALIVE_SCRIPT);
    expect(up.ok).toBe(true);
    const scriptPath = (up.value as { path: string }).path;
    const pidFile = join(deliver, 'pid.txt');
    const execP = driver.exec({ argv: ['node', scriptPath, pidFile], cwd: deliver });
    driver.onExecChunk(execP.opId, () => {}); // 流块订阅占位（内容本用例不消费）
    // 不 await execP：永驻脚本的 op 结果只在进程退出时回流——本用例的结局
    // 是被失电收割（结果帧随断链丢弃，promise 悬置是哑管道契约）。
    // 进程已真跑的正面证据 = PID 标记 + 存活探针
    const pid = Number(
      await waitFor(() =>
        fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : undefined,
      ),
    );
    expect(processAlive(pid)).toBe(true);

    // 杀链路 → 失电保护（宁杀勿失控）：运行中 exec 进程树被收割
    const port = Number(new URL(relay.url).port);
    await relay.close();
    await waitFor(() => (processAlive(pid) ? undefined : true), 10_000);

    // 断链期新 op「立拒」：哑管道不缓存不重放（重发语义归上层）——op 帧随
    // 断链在中继丢弃，驱动 promise 悬而不决、行车记录零行、零副作用（T12
    // 的 linkDown 立拒闸对下行新 op 在单 socket 拓扑不可达——断链即无投递
    // 路径；闸本身的单测覆盖在 session.test.ts，此处断言线的可观察面）
    const duringDown = driver.exec({ argv: ['node', 'during-down.js'], cwd: deliver });

    // 宽限内同端口重启 → 自动重连 → markLinkUp 'resumed' 落账
    const relay2 = await startMockRelay(port);
    relays.push(relay2);
    bridge.attachTo(relay2); // 路由重绑新 relay（通道订阅在驱动侧，不丢）
    await waitFor(() => {
      const parsed = readLogLines(logFile);
      return parsed.some(
        (l) => l['kind'] === 'lifecycle' && l['event'] === 'resumed',
      )
        ? true
        : undefined;
    }, 10_000);
    await relay2.driver.waitFor(() =>
      relay2.frameLog.some((f) => f.type === 'device.hello') ? true : undefined,
    );

    // 后续 op 又能跑：单 exec 槽已被收割腾空、会话幸存、确认回路照常
    const after = await driver.fsWrite('after-resume.txt', 'ok', 'utf8');
    expect(after.ok).toBe(true);
    expect(fs.readFileSync(join(deliver, 'after-resume.txt'), 'utf8')).toBe('ok');

    // 断链期 op 的落点核验（resume 站稳后查，排除在途窗口）：未执行、未排队、
    // 无重放（驱动 promise 仍悬置、executor 从未见它——op_request 零行）；
    // 被杀 exec 的结果同样永不回流
    expect(await racePending(duringDown)).toBe('pending');
    expect(await racePending(execP)).toBe('pending');
    const lines = readLogLines(logFile);
    expect(logByOp(lines, 'op_request', duringDown.opId)).toBeUndefined();
    expect(logByOp(lines, 'op', duringDown.opId)).toBeUndefined();
    expect(fs.existsSync(pidFile)).toBe(true); // PID 标记仍在（进程已死不擦文件）

    // 收尾：终局受理回执落 frameLog（新 relay）
    relay2.driver.end('completed');
    await waitFor(() => {
      const parsed = readLogLines(logFile);
      const last = parsed[parsed.length - 1];
      return last !== undefined && last['kind'] === 'session_end' ? true : undefined;
    }, 5_000);
    const finalLines = readLogLines(logFile);
    expect(finalLines[finalLines.length - 1]).toMatchObject({
      kind: 'session_end',
      reason: 'completed',
    });
    expect(
      finalLines.some(
        (l) => l['kind'] === 'lifecycle' && l['event'] === 'link_down',
      ),
    ).toBe(true);
  }, 30_000);

  it('③b 超宽限：断链后无人认领 → disconnectGraceMs 到点自动终局(grace_expired)、scratch 焚；平台侧补 end 遭拒（计费已停）、独占座位已释放', async () => {
    const stack = await startStack('grace');
    const { relay, deliver, home, bridge } = stack;
    const policy = makePolicy([deliver]);
    // 超宽限口径：宽限 < 重连首拨（1s 退避）——到点无人认领即自动终局
    policy.limits = { ...policy.limits, disconnectGraceMs: 400 };
    await offerAndAttach(stack, policy, 'sess-grace');
    const logFile = join(home, 'logs', 'sess-grace.jsonl');
    const scratch = join(deliver, '.clawrent', 'scratch', 'sess-grace');
    expect(fs.existsSync(scratch)).toBe(true);

    // 杀链路且不在宽限内回来 → 自动终局（「超时自动 end」，会话绝不悬挂占锁）
    const port = Number(new URL(relay.url).port);
    await relay.close();
    const last = await waitFor(() => {
      const parsed = readLogLines(logFile);
      const tail = parsed[parsed.length - 1];
      return tail !== undefined && tail['kind'] === 'session_end' ? tail : undefined;
    }, 10_000);
    expect(last).toMatchObject({
      kind: 'session_end',
      reason: 'grace_expired',
    });
    expect(fs.existsSync(scratch)).toBe(false); // 自动终局同样即焚

    // 重新接通：markLinkUp 'grace_expired'（你来晚了）——会话已不在
    const relay2 = await startMockRelay(port);
    relays.push(relay2);
    bridge.attachTo(relay2);
    await relay2.driver.waitFor(() =>
      relay2.frameLog.some((f) => f.type === 'device.hello') ? true : undefined,
    );

    // 平台侧补发终局（reason grace_expired）→ 机甲拒：无 active session——
    // frameLog 的终态帧即「计费停止语义」：计费在自动终局时已止，平台迟到
    // 的 end 不再产生受理回执
    relay2.driver.end('grace_expired');
    const reject = await relay2.driver.waitFor(() =>
      relay2.frameLog.find(
        (f) => f.type === 'session.reject' && f.reason === 'no active session',
      ),
    );
    expect(reject.type).toBe('session.reject');

    // 独占座位已释放：新 offer 立即受理（attach 回执 = 新计费周期起点）
    const policy2 = makePolicy([deliver]);
    relay2.driver.offer(policy2, 'sess-grace-2', 'driver-grace-2');
    await waitFor(() =>
      stack.manifests.find((m) => m.sessionId === 'sess-grace-2'),
    );
    expect(
      relay2.frameLog.some(
        (f) => f.type === 'session.accept' && f.sessionId === 'sess-grace-2',
      ),
    ).toBe(true);
  }, 30_000);

  it('④ 跨会话马甲：会话1 upload→move 洗名入白名单（R11 落溯源）→会话2 exec 洗名产物照样 T2 红卡→人拒→CONFIRM_DENIED、进程未跑', async () => {
    const stack = await startStack('mask');
    const { relay, driver, deliver, home } = stack;
    const policy = makePolicy([deliver]);
    const marker = join(deliver, 'evil-ran.txt');

    // 会话 1：上传脚本 → fsMove 改名挪进白名单根（洗名尝试；R11：目的地入溯源）
    await offerAndAttach(stack, policy, 'sess-m1');
    const up = await driver.upload(
      'evil.js',
      "require('node:fs').writeFileSync(process.argv[2],'evil-ran');",
    );
    expect(up.ok).toBe(true);
    const evilPath = (up.value as { path: string }).path;
    const innocentPath = join(deliver, 'innocent.js');
    const mv = await driver.fsMove(evilPath, innocentPath);
    expect(mv.ok).toBe(true);
    // 溯源落地：move 目的地入红链（洗白链封堵证据）
    const prov1 = JSON.parse(
      fs.readFileSync(join(home, 'provenance.json'), 'utf8'),
    ) as { entries: Array<{ path: string }> };
    expect(
      prov1.entries.map((e) => normPath(e.path)),
    ).toContain(normPath(realpathCanonical(innocentPath)));
    relay.driver.end('completed');
    await waitFor(() => {
      const lines = readLogLines(join(home, 'logs', 'sess-m1.jsonl'));
      const last = lines[lines.length - 1];
      return last !== undefined && last['kind'] === 'session_end' ? true : undefined;
    });
    expect(fs.existsSync(evilPath)).toBe(false); // 会话 1 即焚：脚本本体已焚

    // 会话 2（同 daemon 同溯源表）：exec 洗名产物 → 照样 T2 红卡
    await offerAndAttach(stack, policy, 'sess-m2');
    stack.confirmMode = 'deny'; // 本次「消费者」点拒绝
    const execP = driver.exec({
      argv: ['node', innocentPath, marker],
      cwd: deliver,
    });
    const r = await execP;
    const maskConfirm = stack.confirms.find((c) => c.opId === execP.opId);
    expect(maskConfirm?.tier).toBe('T2'); // 跨会话溯源判红（Review Focus #3）
    expect(maskConfirm?.summary.startsWith('红卡警告：')).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.tier).toBe('T2');
    expect(r.error?.code).toBe(Mecha.MECHA_ERROR_CODES[2]); // CONFIRM_DENIED
    expect(fs.existsSync(marker)).toBe(false); // 人拒 → 进程未跑（零副作用）

    // 收尾终局（确认已被拒、op 已结，end 立即受理）
    relay.driver.end('completed');
    await waitFor(() => {
      const lines = readLogLines(join(home, 'logs', 'sess-m2.jsonl'));
      const last = lines[lines.length - 1];
      return last !== undefined && last['kind'] === 'session_end' ? true : undefined;
    });
    expect(readLogLines(join(home, 'logs', 'sess-m2.jsonl')).slice(-1)[0]).toMatchObject({
      kind: 'session_end',
      reason: 'completed',
    });
  }, 30_000);

  it('⑤ 假 python.bat：白名单目录植入体不构成程序表成员——exec python 硬拒 PROGRAM_DENIED（零确认、零执行）', async () => {
    const stack = await startStack('bat');
    const { driver, deliver } = stack;
    const policy = makePolicy([deliver]); // 程序表仅 node——植入体不在表内
    await offerAndAttach(stack, policy, 'sess-bat');

    // 白名单目录植入假 python.bat（环境植入面——不经任何驾驶 op）
    fs.writeFileSync(join(deliver, 'python.bat'), '@echo fake-python %*\r\n');

    const confirmsBefore = stack.confirms.length;
    const r = await driver.exec({
      argv: ['python', '-c', 'print("pwned")'],
      cwd: deliver,
    });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe(Mecha.MECHA_ERROR_CODES[1]); // PROGRAM_DENIED
    // 硬拒不弹确认（判级①先于一切）：该 op 无任何 confirmRequest
    expect(stack.confirms.slice(confirmsBefore)).toHaveLength(0);
  }, 20_000);

  it('⑥ halt（IPC）：armed 会话立即终局(consumer_halt)、运行中 exec 被杀、后续 op 拒、status 回 idle', async () => {
    const profile = 'halt';
    const stack = await startStack(profile);
    const { driver, deliver, home } = stack;
    const policy = makePolicy([deliver]);
    await offerAndAttach(stack, policy, 'sess-halt');
    const pipe = safeIpcName(profile);
    const logFile = join(home, 'logs', 'sess-halt.jsonl');

    // armed 快照（IPC status 镜像会话态）
    const armed = await ipcCall(pipe, 'status');
    expect(armed.ok).toBe(true);
    if (armed.ok) {
      expect(armed.state).toBe('armed');
      expect(armed.sessionId).toBe('sess-halt');
    }

    // 长跑 exec（T2 红卡批）→ 进程在跑。不 await：结果只在进程退出时回流
    //（结局 = halt 收割，届时结果以 IO_ERROR 回流、promise 自然收口）
    const up = await driver.upload('keepalive.js', KEEPALIVE_SCRIPT);
    expect(up.ok).toBe(true);
    const scriptPath = (up.value as { path: string }).path;
    const pidFile = join(deliver, 'pid.txt');
    void driver.exec({ argv: ['node', scriptPath, pidFile], cwd: deliver });
    const pid = Number(
      await waitFor(() =>
        fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : undefined,
      ),
    );
    expect(processAlive(pid)).toBe(true);

    // IPC 刹车：立即终局（杀 exec + 收割确认 + 焚 scratch + 合卷）
    const halted = await ipcCall(pipe, 'halt');
    expect(halted).toEqual({ ok: true });
    await waitFor(() => (processAlive(pid) ? undefined : true), 10_000);
    const after = await ipcCall(pipe, 'status');
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.state).toBe('idle');
      expect(after.sessionId).toBeUndefined();
    }
    expect(fs.existsSync(join(deliver, '.clawrent', 'scratch', 'sess-halt'))).toBe(
      false,
    );

    // 后续 op 拒（链路在、结果回流）：IO_ERROR 'no active session'
    const late = await driver.fsWrite('post-halt.txt', 'x', 'utf8');
    expect(late.ok).toBe(false);
    expect(late.error?.code).toBe(Mecha.MECHA_ERROR_CODES[6]); // IO_ERROR
    expect(late.error?.message).toBe('no active session');
    expect(fs.existsSync(join(deliver, 'post-halt.txt'))).toBe(false);

    // 行车记录：consumer_halt 生命周期行 + session_end(consumer_halt) 恒末行
    await waitFor(() => {
      const lines = readLogLines(logFile);
      const last = lines[lines.length - 1];
      return last !== undefined && last['kind'] === 'session_end' ? true : undefined;
    });
    const lines = readLogLines(logFile);
    expect(
      lines.some((l) => l['kind'] === 'lifecycle' && l['event'] === 'consumer_halt'),
    ).toBe(true);
    expect(lines[lines.length - 1]).toMatchObject({
      kind: 'session_end',
      reason: 'consumer_halt',
    });
  }, 30_000);
});
