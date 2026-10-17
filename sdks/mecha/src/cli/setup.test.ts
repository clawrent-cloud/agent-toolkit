import { describe, expect, it } from 'vitest';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import { runSetup, type SetupFs, type SetupIo } from './setup.js';

/**
 * setup 向导测试（plan Task 18）。全部依赖注入，零真实 fs / 网络 / 子进程：
 * - io 注入按脚本逐问应答（脚本耗尽即抛——交互契约走偏显式失败）；
 * - fetch 按 URL 后缀路由（device flow 两端点 + 设备注册端点）；device code
 *   的 interval 给 0.001s——真实 timer 睡 1ms 即轮询，不需要 fake timers；
 * - exec 按 args[0]（程序名）应答，where/which 与平台无关；
 * - fs 为内存替身（existing 决定 existsSync，realpathSync 身份映射——
 *   规范形由测试自控）。
 */

// ── mock 基建 ────────────────────────────────────────────────────────────────

const HOME = homedir();
const DESKTOP = join(HOME, 'Desktop');
const DOCUMENTS = join(HOME, 'Documents');
const CUSTOM = process.platform === 'win32' ? 'D:\\proj' : '/tmp/mecha-proj-18';
const HOME_OVERRIDE = join(tmpdir(), 'mecha-setup-test-18');

/** 按脚本逐问应答的 io 替身；脚本耗尽即抛。 */
function scriptIo(answers: string[]): {
  io: SetupIo;
  notes: string[];
  asks: string[];
} {
  const notes: string[] = [];
  const asks: string[] = [];
  let i = 0;
  const io: SetupIo = {
    ask: async (prompt) => {
      asks.push(prompt);
      const a = answers[i];
      i += 1;
      if (a === undefined) {
        throw new Error(`scriptIo: 脚本耗尽（第 ${i} 问：${prompt}）`);
      }
      return a;
    },
    note: (s) => {
      notes.push(s);
    },
  };
  return { io, notes, asks };
}

/** 内存 fs 替身。sizes = 程序真身的 stat 大小表（I4 占位桩探测；缺省 10）。 */
function memFs(existing: string[], sizes: Record<string, number> = {}): {
  fsImpl: SetupFs;
  writes: Array<{ path: string; data: string }>;
  mkdirs: string[];
  chmods: Array<{ path: string; mode: number }>;
} {
  const present = new Set(existing);
  const writes: Array<{ path: string; data: string }> = [];
  const mkdirs: string[] = [];
  const chmods: Array<{ path: string; mode: number }> = [];
  const fsImpl: SetupFs = {
    existsSync: (p) => present.has(p),
    realpathSync: (p) => p,
    statSync: (p) => {
      if (!present.has(p)) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
      }
      return { size: sizes[p] ?? 10 };
    },
    mkdirSync: (p) => {
      mkdirs.push(p);
    },
    writeFileSync: (p, data) => {
      writes.push({ path: p, data });
    },
    chmodSync: (p, mode) => {
      chmods.push({ path: p, mode });
    },
  };
  return { fsImpl, writes, mkdirs, chmods };
}

const DEVICE_CODE_OK = {
  deviceCode: 'DC-18',
  userCode: 'MECH-18',
  verificationUri: 'https://clawrent.test/mecha/activate',
  expiresIn: 600,
  interval: 0.001, // 真实 timer 睡 1ms 即轮询
};

interface HttpCall {
  url: string;
  init: RequestInit;
}

/** 按 URL 后缀路由的 fetch 替身。 */
function mockFetchRoutes(routes: Record<string, { status: number; body: unknown }>): {
  fetchImpl: typeof fetch;
  calls: HttpCall[];
} {
  const calls: HttpCall[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    for (const [suffix, res] of Object.entries(routes)) {
      if (url.endsWith(suffix)) {
        return {
          status: res.status,
          ok: res.status >= 200 && res.status < 300,
          json: async () => res.body,
          text: async () => JSON.stringify(res.body),
        } as unknown as Response;
      }
    }
    throw new Error(`mockFetchRoutes: 未预期 URL ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 按程序名（args[0]）应答的 exec 替身。 */
function fakeExec(results: Record<string, string | Error>): {
  execImpl: (cmd: string, args: string[]) => Promise<{ stdout: string }>;
  calls: Array<{ cmd: string; args: string[] }>;
} {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const execImpl = async (
    cmd: string,
    args: string[],
  ): Promise<{ stdout: string }> => {
    calls.push({ cmd, args });
    const r = results[args[0] ?? ''];
    if (r instanceof Error) throw r;
    if (r === undefined) throw new Error(`${args[0]}: command not found`);
    return { stdout: r };
  };
  return { execImpl, calls };
}

const WIN32 = process.platform === 'win32';
const PROBE_CMD = WIN32 ? 'where' : 'which';
const PY = WIN32 ? 'C:\\Python312\\python.exe' : '/usr/bin/python3';
const NODE = WIN32 ? 'C:\\Program Files\\nodejs\\node.exe' : '/usr/bin/node';

const HAPPY_ROUTES = {
  // 端点统一口径（0.1.1）：路由 key 用完整 /api 前缀路径——device flow 若
  // 回退到 0.1.0 的 /auth/device/... 拼法，后缀不匹配即响亮失败（未预期 URL）。
  '/api/auth/device/code': { status: 200, body: DEVICE_CODE_OK },
  '/api/auth/device/token': {
    status: 200,
    body: { deviceId: 'mecha-18', deviceToken: 'dtok-18' },
  },
  '/api/mecha/devices': { status: 200, body: { ok: true } },
};

// ── 用例 ────────────────────────────────────────────────────────────────────

describe('runSetup（setup 向导,T18）', () => {
  it('主流程：io 选「文档+自定义」→ policy.dirs 含两者；none 档 programs 空；POST body 与 config.json 四字段落盘', async () => {
    const { io, notes } = scriptIo(['1', CUSTOM, '', '1']);
    const { fsImpl, writes, mkdirs } = memFs([DOCUMENTS, CUSTOM]);
    const { fetchImpl, calls } = mockFetchRoutes(HAPPY_ROUTES);
    // none 档不应探测：exec 替身一被调用即抛
    const { execImpl, calls: execCalls } = fakeExec({});

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      execImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(result.deviceId).toBe('mecha-18');
    // 目录：文档 + 自定义，均经 realpath（替身身份映射 → 原样）
    expect(result.policy.dirs).toEqual([DOCUMENTS, CUSTOM]);
    // none 档：空 programs；限额 = MECHA_LIMITS_DEFAULTS
    expect(result.policy.programs).toEqual([]);
    expect(result.policy.limits).toEqual(Mecha.MECHA_LIMITS_DEFAULTS);
    expect(execCalls).toHaveLength(0);
    // POST：端点 / 方法 / 鉴权头 / body
    const post = calls.find((c) => c.url.endsWith('/api/mecha/devices'));
    expect(post).toBeDefined();
    expect(post?.init.method).toBe('POST');
    expect((post?.init.headers as Record<string, string>)['authorization']).toBe(
      'Bearer dtok-18',
    );
    // 端点统一口径（0.1.1）：三端点全部落在 ${apiBase}/api/... 前缀下，
    // 精确全 URL（device flow 两步 + 设备注册一步,次序如实）
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.clawrent.test/api/auth/device/code',
      'https://api.clawrent.test/api/auth/device/token',
      'https://api.clawrent.test/api/mecha/devices',
    ]);
    expect(JSON.parse(String(post?.init.body))).toEqual({
      deviceId: 'mecha-18',
      policy: result.policy,
    });
    // config.json：目录自建 + 四字段落盘 + 返回路径一致
    const cfgPath = join(HOME_OVERRIDE, 'config.json');
    expect(mkdirs).toEqual([HOME_OVERRIDE]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe(cfgPath);
    expect(JSON.parse(writes[0]!.data)).toEqual({
      deviceId: 'mecha-18',
      deviceToken: 'dtok-18',
      apiBase: 'https://api.clawrent.test',
      profile: 'default',
    });
    expect(result.configPath).toBe(cfgPath);
    expect(result.runtimeInstalled).toBe(false);
    expect(result.autostartInstalled).toBe(false);
    // 白名单诚实文案出现在目录选择步骤；完成摘要含本地刹车安全提示
    expect(notes.join('\n')).toContain('你愿意被驾驶员读到、并可能被发送出去的范围');
    expect(notes.join('\n')).toContain('mecha halt');
  });

  it('dev 档探测：mock exec 假 PATH 输出 → programs 含 absPath 真身（首行胜出）；git 缺失跳过并提示', async () => {
    const { io, notes } = scriptIo(['1', '', '2']);
    const { fsImpl } = memFs([DOCUMENTS, PY, NODE]); // 真身实存（I4 stat 探测的盘上面）
    const { fetchImpl, calls } = mockFetchRoutes(HAPPY_ROUTES);
    const { execImpl, calls: execCalls } = fakeExec({
      python: `${PY}\r\nC:\\other\\python.exe\r\n`, // 多行：FIRST 匹配行胜出
      node: `${NODE}\n`,
      // git 缺失 → reject → 跳过
    });

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      execImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(result.policy.programs).toEqual([
      { name: 'python', absPath: PY },
      { name: 'node', absPath: NODE },
    ]);
    expect(notes.join('\n')).toContain('未找到 git，已跳过（可稍后在网页添加）');
    // 探测命令跨平台：win32 where / posix which，逐名调用
    expect(execCalls.map((c) => c.cmd)).toEqual([PROBE_CMD, PROBE_CMD, PROBE_CMD]);
    expect(execCalls.map((c) => c.args)).toEqual([['python'], ['node'], ['git']]);
    expect(calls.some((c) => c.url.endsWith('/api/mecha/devices'))).toBe(true);
  });

  it('探测全失败：programs 空数组 + 逐个跳过提示（dev 档照样完成注册）', async () => {
    const { io, notes } = scriptIo(['1', '', '2']);
    const { fsImpl } = memFs([DOCUMENTS]);
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);
    const { execImpl } = fakeExec({});

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      execImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(result.policy.programs).toEqual([]);
    const all = notes.join('\n');
    expect(all).toContain('未找到 python，已跳过（可稍后在网页添加）');
    expect(all).toContain('未找到 node，已跳过（可稍后在网页添加）');
    expect(all).toContain('未找到 git，已跳过（可稍后在网页添加）');
  });

  it('相对自定义路径拒绝：提示非法并留在自定义循环，随后的绝对路径正常入列', async () => {
    const { io, notes } = scriptIo(['1', 'proj', CUSTOM, '', '1']);
    const { fsImpl } = memFs([DOCUMENTS, CUSTOM]);
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(notes.join('\n')).toContain('不是绝对路径');
    expect(result.policy.dirs).toEqual([DOCUMENTS, CUSTOM]);
  });

  it('零目录：提示至少一个并重问目录步骤，第二轮选中后继续', async () => {
    const { io, notes } = scriptIo(['', '', '1', '', '1']);
    const { fsImpl } = memFs([DOCUMENTS]);
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(notes.join('\n')).toContain('至少需要选择一个白名单目录');
    expect(result.policy.dirs).toEqual([DOCUMENTS]);
  });

  it('快捷项无效编号：提示并重问快捷项', async () => {
    const { io, notes } = scriptIo(['9', '1', '', '1']);
    const { fsImpl } = memFs([DOCUMENTS]);
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(notes.join('\n')).toContain('无效编号');
    expect(result.policy.dirs).toEqual([DOCUMENTS]);
  });

  it('注册非 2xx：抛错且消息携带 status 与响应 body', async () => {
    const { io } = scriptIo(['1', '', '1']);
    const { fsImpl } = memFs([DOCUMENTS]);
    const { fetchImpl } = mockFetchRoutes({
      '/api/auth/device/code': { status: 200, body: DEVICE_CODE_OK },
      '/api/auth/device/token': {
        status: 200,
        body: { deviceId: 'mecha-18', deviceToken: 'dtok-18' },
      },
      '/api/mecha/devices': { status: 403, body: { error: 'forbidden' } },
    });

    await expect(
      runSetup({
        apiBase: 'https://api.clawrent.test',
        io,
        fetchImpl,
        fsImpl,
        homeOverride: HOME_OVERRIDE,
      }),
    ).rejects.toThrow(/status 403/);
    await expect(
      runSetup({
        apiBase: 'https://api.clawrent.test',
        io: scriptIo(['1', '', '1']).io,
        fetchImpl,
        fsImpl,
        homeOverride: HOME_OVERRIDE,
      }),
    ).rejects.toThrow(/forbidden/);
  });

  it('hooks 注入（T19 席位）：installRuntime → installAutostart 依序各调一次，结果旗标 true', async () => {
    const { io } = scriptIo(['1', '', '1']);
    const { fsImpl } = memFs([DOCUMENTS]);
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);
    const order: string[] = [];

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
      hooks: {
        installRuntime: async () => {
          order.push('runtime');
        },
        installAutostart: async () => {
          order.push('autostart');
        },
      },
    });

    expect(order).toEqual(['runtime', 'autostart']);
    expect(result.runtimeInstalled).toBe(true);
    expect(result.autostartInstalled).toBe(true);
  });

  it('profile 覆盖写盘；apiBase 尾斜杠归一；权限处理随平台（win32 跳过并提示 / POSIX chmod 0o600）', async () => {
    const { io, notes } = scriptIo(['1', '', '1']);
    const { fsImpl, writes, chmods } = memFs([DOCUMENTS]);
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test/',
      io,
      fetchImpl,
      fsImpl,
      profile: 'lab',
      homeOverride: HOME_OVERRIDE,
    });

    const cfgPath = join(HOME_OVERRIDE, 'config.json');
    expect(JSON.parse(writes[0]!.data)).toEqual({
      deviceId: 'mecha-18',
      deviceToken: 'dtok-18',
      apiBase: 'https://api.clawrent.test',
      profile: 'lab',
    });
    expect(result.configPath).toBe(cfgPath);
    if (WIN32) {
      expect(chmods).toHaveLength(0);
      expect(notes.join('\n')).toContain('权限收紧');
    } else {
      expect(chmods).toEqual([{ path: cfgPath, mode: 0o600 }]);
    }
  });

  it('快捷项只提供存在的目录（桌面/文档在、下载不在），编号按列出顺序选择', async () => {
    const { io, asks } = scriptIo(['2', '', '1']); // '2' = 列表第 2 项 = 文档
    const { fsImpl } = memFs([DESKTOP, DOCUMENTS]); // 下载不存在 → 不出现
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(asks[0]).toContain('桌面');
    expect(asks[0]).toContain('文档');
    expect(asks[0]).not.toContain('下载');
    expect(result.policy.dirs).toEqual([DOCUMENTS]);
  });

  it('自定义路径与快捷项 realpath 相同 → 去重为一条', async () => {
    const { io } = scriptIo(['1', DOCUMENTS, '', '1']);
    const { fsImpl } = memFs([DOCUMENTS]);
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(result.policy.dirs).toEqual([DOCUMENTS]);
  });

  it('I4：0 字节占位桩（Windows Store alias）→ 跳过并提示占位桩；正常文件照常注册', async () => {
    const { io, notes } = scriptIo(['1', '', '2']);
    const { fsImpl } = memFs([DOCUMENTS, PY, NODE], { [PY]: 0, [NODE]: 1024 });
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);
    const { execImpl } = fakeExec({ python: `${PY}\n`, node: `${NODE}\n` });

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      execImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(result.policy.programs).toEqual([{ name: 'node', absPath: NODE }]);
    expect(notes.join('\n')).toContain('Windows Store 占位桩');
    expect(notes.join('\n')).toContain('已跳过');
  });

  it('I4：真身 realpath 落在 WindowsApps 下（reparse 别名归宿）→ 跳过并提示占位桩', async () => {
    const storePy = WIN32
      ? 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'
      : '/home/u/AppData/Local/Microsoft/WindowsApps/python3';
    const { io, notes } = scriptIo(['1', '', '2']);
    const { fsImpl } = memFs([DOCUMENTS, storePy, NODE], { [storePy]: 4096, [NODE]: 1024 });
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);
    const { execImpl } = fakeExec({ python: `${storePy}\n`, node: `${NODE}\n` });

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      execImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(result.policy.programs).toEqual([{ name: 'node', absPath: NODE }]);
    expect(notes.join('\n')).toContain('Windows Store 占位桩');
  });

  it('I4：真身 stat 不可判定（探测竞态）→ 按跳过处理不注册', async () => {
    const { io, notes } = scriptIo(['1', '', '2']);
    const { fsImpl } = memFs([DOCUMENTS, PY]); // NODE 不在 present → statSync ENOENT
    const { fetchImpl } = mockFetchRoutes(HAPPY_ROUTES);
    const { execImpl } = fakeExec({ python: `${PY}\n`, node: `${NODE}\n` });

    const result = await runSetup({
      apiBase: 'https://api.clawrent.test',
      io,
      fetchImpl,
      execImpl,
      fsImpl,
      homeOverride: HOME_OVERRIDE,
    });

    expect(result.policy.programs).toEqual([{ name: 'python', absPath: PY }]);
    expect(notes.join('\n')).toContain('未找到 node，已跳过（可稍后在网页添加）');
  });
});
