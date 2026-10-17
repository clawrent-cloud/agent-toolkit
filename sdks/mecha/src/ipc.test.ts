import { afterAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { ipcName } from './constants.js';
import {
  assertValidPipeName,
  assertValidProfile,
  DEFAULT_IPC_TIMEOUT_MS,
  IpcDownError,
  ipcCall,
  IpcServer,
  IpcTimeoutError,
  safeIpcName,
  type IpcHandlers,
  type MechaStatus,
} from './ipc.js';

// T15：本地 IPC（win32 命名管道 / POSIX UDS）——离线刹车通道。
// 真端点集成（plan 全局约束：传输层不 mock，命名管道/UDS 仅本机可达）。

let seq = 0;
/** 唯一且合法的测试 profile（字母数字与 -，跨测试互不撞名）。 */
function uniqProfile(): string {
  seq += 1;
  return `t15-${process.pid}-${seq}`;
}

const openServers: IpcServer[] = [];
const extraSockets: net.Socket[] = [];

async function startServer(
  handlers: IpcHandlers,
  profile?: string,
): Promise<{ server: IpcServer; pipeName: string }> {
  const pipeName = ipcName(profile ?? uniqProfile());
  const server = new IpcServer(pipeName, handlers);
  await server.listen();
  openServers.push(server);
  return { server, pipeName };
}

/** 绕过 ipcCall 的原始客户端（测协议层坏请求面）。 */
function rawRequest(pipeName: string, line: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(pipeName);
    extraSockets.push(sock);
    let buffered = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(`${line}\n`));
    sock.on('data', (chunk: string) => {
      buffered += chunk;
      const nl = buffered.indexOf('\n');
      if (nl !== -1) {
        sock.destroy();
        resolve(buffered.slice(0, nl));
      }
    });
    sock.on('error', reject);
  });
}

afterAll(async () => {
  for (const server of openServers.splice(0).reverse()) {
    await server.close();
  }
  for (const sock of extraSockets.splice(0)) {
    sock.destroy();
  }
});

const STATUS_ARMED: MechaStatus = {
  state: 'armed',
  sessionId: 'sess-1',
  driverAgentId: 'agent-driver-1',
  since: 1700000000000,
  activeOp: 'op-7',
};

describe('IpcServer + ipcCall（本地刹车通道）', () => {
  it('IPC round-trip：status 取回完整状态快照', async () => {
    const { pipeName } = await startServer({
      status: () => STATUS_ARMED,
      halt: () => undefined,
    });
    const res = await ipcCall(pipeName, 'status');
    expect(res.ok).toBe(true);
    if (!res.ok) return; // 窄化
    expect(res.state).toBe('armed');
    expect(res.sessionId).toBe('sess-1');
    expect(res.driverAgentId).toBe('agent-driver-1');
    expect(res.since).toBe(1700000000000);
    expect(res.activeOp).toBe('op-7');
  });

  it('idle 快照（可选字段缺省）也 round-trip', async () => {
    const { pipeName } = await startServer({
      status: (): MechaStatus => ({ state: 'idle', since: 1 }),
      halt: () => undefined,
    });
    const res = await ipcCall(pipeName, 'status');
    expect(res).toMatchObject({ ok: true, state: 'idle', since: 1 });
  });

  it('halt：回调被调、响应 {ok:true}；重复请求幂等受理', async () => {
    const halt = vi.fn();
    const { pipeName } = await startServer({
      status: (): MechaStatus => ({ state: 'idle', since: 1 }),
      halt,
    });
    const r1 = await ipcCall(pipeName, 'halt');
    const r2 = await ipcCall(pipeName, 'halt');
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(halt).toHaveBeenCalledTimes(2);
  });

  it('两个 profile 管道名互不干扰（同进程双服务器）', async () => {
    const a = await startServer(
      {
        status: (): MechaStatus => ({ state: 'armed', sessionId: 'sess-A', since: 1 }),
        halt: () => undefined,
      },
      `t15-${process.pid}-pa`,
    );
    const b = await startServer(
      {
        status: (): MechaStatus => ({ state: 'paused', sessionId: 'sess-B', since: 2 }),
        halt: () => undefined,
      },
      `t15-${process.pid}-pb`,
    );
    expect(a.pipeName).not.toBe(b.pipeName);
    const [ra, rb] = await Promise.all([
      ipcCall(a.pipeName, 'status'),
      ipcCall(b.pipeName, 'status'),
    ]);
    expect(ra).toMatchObject({ ok: true, sessionId: 'sess-A', state: 'armed' });
    expect(rb).toMatchObject({ ok: true, sessionId: 'sess-B', state: 'paused' });
  });

  it('并发连接（status 轮询）全部应答', async () => {
    const { pipeName } = await startServer({
      status: () => STATUS_ARMED,
      halt: () => undefined,
    });
    const results = await Promise.all(
      Array.from({ length: 4 }, () => ipcCall(pipeName, 'status')),
    );
    for (const r of results) expect(r.ok).toBe(true);
  });

  it('协议坏请求：非 JSON / 非对象 / 未知命令 → {ok:false,error}，服务器不炸', async () => {
    const { pipeName } = await startServer({
      status: () => STATUS_ARMED,
      halt: () => undefined,
    });
    expect(JSON.parse(await rawRequest(pipeName, 'not-json'))).toMatchObject({ ok: false });
    expect(JSON.parse(await rawRequest(pipeName, '"str"'))).toMatchObject({ ok: false });
    expect(
      JSON.parse(await rawRequest(pipeName, JSON.stringify({ cmd: 'restart' }))),
    ).toMatchObject({ ok: false, error: expect.stringContaining('unknown command') });
    const res = await ipcCall(pipeName, 'status'); // 坏请求之后照常服务
    expect(res.ok).toBe(true);
  });

  it('handlers 抛错 → {ok:false,error} 透出（status 与 halt 各自）', async () => {
    const { pipeName } = await startServer({
      status: () => {
        throw new Error('boom-status');
      },
      halt: () => {
        throw new Error('boom-halt');
      },
    });
    expect(
      JSON.parse(await rawRequest(pipeName, JSON.stringify({ cmd: 'status' }))),
    ).toMatchObject({ ok: false, error: 'boom-status' });
    expect(
      JSON.parse(await rawRequest(pipeName, JSON.stringify({ cmd: 'halt' }))),
    ).toMatchObject({ ok: false, error: 'boom-halt' });
  });

  it('daemon 未运行：ipcCall 以 IpcDownError 拒绝（干净失败，无 unhandled rejection）', async () => {
    const pipeName = ipcName(uniqProfile()); // 无服务器监听
    const err: unknown = await ipcCall(pipeName, 'status').then(
      () => {
        throw new Error('应当拒绝');
      },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(IpcDownError);
    expect((err as IpcDownError).code).toBeTypeOf('string');
  });

  it('默认超时 3s（~3s connect timeout 裁定）', () => {
    expect(DEFAULT_IPC_TIMEOUT_MS).toBe(3000);
  });

  it('服务器受理不回话 → 短超时 IpcTimeoutError', async () => {
    const pipeName = ipcName(uniqProfile());
    const silent = net.createServer((sock) => {
      extraSockets.push(sock);
      sock.on('error', () => undefined);
      sock.resume(); // 消费请求但不应答——连接保持打开（win32 管道上暂停不读会断连）
    });
    await new Promise<void>((resolve, reject) => {
      silent.once('error', reject);
      silent.listen(pipeName, () => resolve());
    });
    try {
      await expect(ipcCall(pipeName, 'status', 200)).rejects.toBeInstanceOf(IpcTimeoutError);
    } finally {
      for (const sock of extraSockets.splice(0)) sock.destroy(); // 先清连接，close 才能落定
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });

  it('端点被活实例占用 → 第二个 listen 拒绝 EADDRINUSE（单实例门），原实例继续应答', async () => {
    const { pipeName } = await startServer({
      status: (): MechaStatus => ({ state: 'armed', sessionId: 'sess-first', since: 1 }),
      halt: () => undefined,
    });
    const second = new IpcServer(pipeName, {
      status: () => STATUS_ARMED,
      halt: () => undefined,
    });
    await expect(second.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' });
    const res = await ipcCall(pipeName, 'status'); // 原实例还活着
    expect(res).toMatchObject({ ok: true, sessionId: 'sess-first' });
    await second.close(); // 未曾 listen 成功，close 幂等收口
  });

  it('close 后同端点可重新 listen（重启语义；POSIX 走死文件清理）', async () => {
    const pipeName = ipcName(uniqProfile());
    const first = new IpcServer(pipeName, {
      status: (): MechaStatus => ({ state: 'idle', since: 1 }),
      halt: () => undefined,
    });
    await first.listen();
    await first.close();
    const second = new IpcServer(pipeName, {
      status: (): MechaStatus => ({ state: 'paused', since: 2 }),
      halt: () => undefined,
    });
    await second.listen();
    openServers.push(second);
    expect(await ipcCall(pipeName, 'status')).toMatchObject({ ok: true, state: 'paused' });
  });
});

// POSIX 专属（UDS 文件语义）；win32 开发机上跳过（POSIX 分支逻辑经 stub 平台单独验证）。
const itUnix = process.platform === 'win32' ? it.skip : it;

describe('POSIX UDS 死文件清理（connect-test-then-unlink）', () => {
  itUnix('close 后 socket 文件残留（崩溃同态），下次 listen 自动清理并可绑定', async () => {
    const pipeName = ipcName(uniqProfile());
    const first = new IpcServer(pipeName, { status: () => STATUS_ARMED, halt: () => undefined });
    await first.listen();
    await first.close();
    expect(fs.existsSync(pipeName)).toBe(true); // close 不删文件 = 崩溃残留同态
    const second = new IpcServer(pipeName, { status: () => STATUS_ARMED, halt: () => undefined });
    await second.listen(); // 自动 unlink 死文件
    openServers.push(second);
    expect(await ipcCall(pipeName, 'status')).toMatchObject({ ok: true });
  });

  itUnix('路径被普通文件占用 → 不误删，listen 响亮失败', async () => {
    const pipeName = ipcName(uniqProfile());
    fs.writeFileSync(pipeName, 'not a socket');
    try {
      const server = new IpcServer(pipeName, {
        status: () => STATUS_ARMED,
        halt: () => undefined,
      });
      await expect(server.listen()).rejects.toThrow();
      expect(fs.existsSync(pipeName)).toBe(true); // 未被清理逻辑误删
    } finally {
      fs.rmSync(pipeName, { force: true });
    }
  });
});

describe('profile 清洗（T5 遗留：ipcName 不清洗，本层补齐）', () => {
  it.each([
    '', // 空
    'a/b', // 路径分隔符
    'a\\b', // Windows 分隔符
    '..', // 点段
    'a..b', // 含 ..
    '.hid', // 非字母数字开头
    'a b', // 空格
    'p:1', // win32 管道名特殊字符
    'x'.repeat(65), // 超长（UDS sun_path 预算）
  ])('拒绝非法 profile %j', (profile) => {
    expect(() => assertValidProfile(profile)).toThrow();
  });

  it('接受合法 profile；safeIpcName = 校验后的 ipcName', () => {
    expect(safeIpcName('default')).toBe(ipcName('default'));
    expect(safeIpcName('work-1.a_b')).toBe(ipcName('work-1.a_b'));
  });
});

describe('端点名形态校验（构造/调用即炸，fail-fast）', () => {
  it('win32 分支（本机分支直接验证）', () => {
    expect(() => assertValidPipeName('/tmp/x.sock')).toThrow(); // win32 下非管道形态
    expect(() => assertValidPipeName('\\\\.\\pipe\\')).toThrow(); // 空主体
    expect(() => assertValidPipeName('\\\\.\\pipe\\a\\b')).toThrow(); // 主体含反斜杠
    expect(() => assertValidPipeName('\\\\.\\pipe\\clawrent-mecha-default')).not.toThrow();
  });

  it('POSIX 分支（stub platform 验证纯逻辑，本机是 win32 也能覆盖）', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux' });
    try {
      expect(() => assertValidPipeName('\\\\.\\pipe\\x')).toThrow();
      expect(() => assertValidPipeName('rel/x.sock')).toThrow(); // 相对路径
      expect(() => assertValidPipeName('/a/../b.sock')).toThrow(); // ".." 段
      expect(() => assertValidPipeName('/tmp/x.sock')).not.toThrow();
      // sun_path 预算（≤103 字节，macOS 保守口径）：103 恰好过、104 拒
      expect(() => assertValidPipeName(`/${'x'.repeat(102)}`)).not.toThrow(); // 1+102=103B
      expect(() => assertValidPipeName(`/${'x'.repeat(103)}`)).toThrow(); // 1+103=104B
      // 多字节按 UTF-8 字节计（60 汉字 = 180B；若误用 .length=61 会漏拦）
      expect(() => assertValidPipeName(`/${'机'.repeat(60)}`)).toThrow();
    } finally {
      Object.defineProperty(process, 'platform', { value: original });
    }
  });

  it('IpcServer 构造即校验（坏端点名不等 listen 才炸）', () => {
    const bad = process.platform === 'win32' ? 'relative-name' : '\\\\.\\pipe\\x';
    expect(
      () => new IpcServer(bad, { status: () => STATUS_ARMED, halt: () => undefined }),
    ).toThrow();
  });
});
