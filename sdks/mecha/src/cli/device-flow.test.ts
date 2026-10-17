import { afterEach, describe, expect, it, vi } from 'vitest';
import { runDeviceFlow } from './device-flow.js';

// ── mock fetch 基建（fake timers 驱动轮询，绝不真实等待）─────────────────────

interface ScriptedResponse {
  status: number;
  body: unknown;
}

/** 按脚本依次应答的 mock fetch；脚本耗尽后**重复最后一项**（总超时用例的
 * pending-forever 靠它表达，不用无限长脚本）。calls 记录每次请求的 URL 与
 * init（method/headers/body 断言的数据源）。 */
function scriptedFetch(script: ScriptedResponse[]): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = script.length > 1 ? script.shift() : script[0];
    if (next === undefined) throw new Error('scriptedFetch: empty script');
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      json: async () => next.body,
    } as unknown as Response;
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** 真身 Promise 的护栏：flow 未在 advance 预算内收敛 → 显式失败而非挂死
 * （fake timers 下 guard 计时器同样由 advance 驱动，与 flow 同时钟）。 */
function guard<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`test guard(${label}): flow 未在 ${ms}ms 内收敛`)), ms);
    }),
  ]);
}

afterEach(() => {
  vi.useRealTimers();
});

// ── 用例 ───────────────────────────────────────────────────────────────────

const CODE_OK = {
  status: 200,
  body: {
    deviceCode: 'DC-1',
    userCode: 'ABCD-1234',
    verificationUri: 'https://clawrent.cloud/mecha/activate',
    expiresIn: 600,
    interval: 1,
  },
};

describe('runDeviceFlow（device flow 认证客户端,T17）', () => {
  it('pending×2 → authorized：返回 deviceId/deviceToken,请求打在平台端点（POST + accept JSON + 轮询带 deviceCode）', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scriptedFetch([
      CODE_OK,
      { status: 202, body: { error: 'authorization_pending' } },
      { status: 202, body: { error: 'authorization_pending' } },
      { status: 200, body: { deviceId: 'mecha-777', deviceToken: 'dtok-xyz' } },
    ]);
    const flow = guard(runDeviceFlow('https://api.clawrent.test', fetchImpl), 60_000, 'happy');
    await vi.advanceTimersByTimeAsync(60_000);
    await expect(flow).resolves.toEqual({ deviceId: 'mecha-777', deviceToken: 'dtok-xyz' });

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.clawrent.test/auth/device/code',
      'https://api.clawrent.test/auth/device/token',
      'https://api.clawrent.test/auth/device/token',
      'https://api.clawrent.test/auth/device/token',
    ]);
    const init = calls[0]?.init;
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['accept']).toBe('application/json');
    // 轮询请求体带 deviceCode（发起码与轮询码一致）
    expect(JSON.parse(String(calls[3]?.init.body))).toEqual({ deviceCode: 'DC-1' });
  });

  it('打印 verificationUri 与 userCode（print 注入收集断言）', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = scriptedFetch([
      CODE_OK,
      { status: 200, body: { deviceId: 'mecha-777', deviceToken: 'dtok-xyz' } },
    ]);
    const printed: string[] = [];
    const flow = guard(
      runDeviceFlow('https://api.clawrent.test', fetchImpl, (s) => printed.push(s)),
      60_000,
      'print',
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flow;
    const all = printed.join('\n');
    expect(all).toContain('https://clawrent.cloud/mecha/activate');
    expect(all).toContain('ABCD-1234');
  });

  it('slow_down 退避：interval 加倍且封顶 30s（R20）——20s 起步,slow_down 后第三次轮询在 t=70 而非 t=80', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scriptedFetch([
      { ...CODE_OK, body: { ...CODE_OK.body, interval: 20 } },
      { status: 202, body: { error: 'authorization_pending' } }, // t=20
      { status: 202, body: { error: 'slow_down' } }, // t=40 → interval=min(40,30)=30
      { status: 200, body: { deviceId: 'mecha-777', deviceToken: 'dtok-xyz' } }, // t=70
    ]);
    let done = false;
    const flow = guard(runDeviceFlow('https://api.clawrent.test', fetchImpl), 200_000, 'slowdown');
    void flow.then(
      () => {
        done = true;
      },
      () => {
        done = true;
      },
    );
    await vi.advanceTimersByTimeAsync(70_000);
    // 封顶生效：第三次轮询 t=70 已完成（若无封顶,interval=40,第三次在 t=80,此处 done 仍为 false）
    expect(done).toBe(true);
    expect(calls).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(flow).resolves.toEqual({ deviceId: 'mecha-777', deviceToken: 'dtok-xyz' });
  });

  it('终态错误（expired_token）：抛错且错误消息携带服务端错误码', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scriptedFetch([
      CODE_OK,
      { status: 200, body: { error: 'expired_token' } },
    ]);
    const flow = guard(runDeviceFlow('https://api.clawrent.test', fetchImpl), 60_000, 'terminal');
    // 断言先于 advance 挂上 handler——拒绝早于断言 await 时不算 unhandled
    const assertion = expect(flow).rejects.toThrow(/expired_token/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    // 终态即停：发起 + 一次轮询,不再继续轮询
    expect(calls).toHaveLength(2);
  });

  it('总超时：expiresIn 秒后抛 expired（不再发出越线轮询）', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scriptedFetch([
      { ...CODE_OK, body: { ...CODE_OK.body, expiresIn: 3 } },
      { status: 202, body: { error: 'authorization_pending' } }, // t=1
      { status: 202, body: { error: 'authorization_pending' } }, // t=2
      // t=3 = deadline:抛 expired,第三次轮询不发出
    ]);
    const flow = guard(runDeviceFlow('https://api.clawrent.test', fetchImpl), 60_000, 'deadline');
    // 断言先于 advance 挂上 handler——拒绝早于断言 await 时不算 unhandled
    const assertion = expect(flow).rejects.toThrow(/expired/);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(calls).toHaveLength(3); // 发起 + 2 次轮询
  });

  it('interval/expiresIn 缺省：5s 轮询、600s 总超时（Zod schema 默认值）', async () => {
    vi.useFakeTimers();
    const { fetchImpl, calls } = scriptedFetch([
      {
        status: 200,
        body: {
          deviceCode: 'DC-2',
          userCode: 'ZZZZ-9999',
          verificationUri: 'https://clawrent.cloud/mecha/activate',
          // interval / expiresIn 缺省 → 5s / 600s
        },
      },
      { status: 202, body: { error: 'authorization_pending' } },
    ]);
    let failed = false;
    const flow = guard(runDeviceFlow('https://api.clawrent.test', fetchImpl), 700_000, 'defaults');
    void flow.catch(() => {
      failed = true;
    });
    await vi.advanceTimersByTimeAsync(4_999);
    expect(calls).toHaveLength(1); // 首次轮询在 t=5,未提前
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2); // t=5 轮询#1
    await vi.advanceTimersByTimeAsync(595_000); // → t=600 = 缺省 deadline
    expect(failed).toBe(true);
    // 轮询 t=5,10,…,595 恰 119 次 + 1 次发起 = 120;t=600 越线不发
    expect(calls).toHaveLength(120);
  });
});
