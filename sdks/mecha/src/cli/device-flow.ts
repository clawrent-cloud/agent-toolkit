import { z } from 'zod';

/**
 * device flow 认证客户端（plan Task 17，spec §8.1：认证只走 device flow，
 * 终端绝不处理密码）。消费者侧机甲授权的唯一凭据入口：
 *
 *  1. POST `<apiBase>/api/auth/device/code` → 平台回
 *     `{ deviceCode, userCode, verificationUri, expiresIn, interval? }`；
 *  2. 把 verificationUri + userCode 打印给用户（print 注入，缺省
 *     console.log——测试收集断言，T18 setup 同样经此打印）；
 *  3. 每 interval 秒 POST `<apiBase>/api/auth/device/token`{deviceCode} 轮询：
 *     - `authorization_pending` → 继续等；
 *     - `slow_down` → interval 加倍，封顶 30s（R20 裁定：加倍的退避，
 *       不是 RFC 8628 的 +5s）；
 *     - 200 且 `{ deviceId, deviceToken }` → 兑现返回（调用方 T18 setup
 *       落盘 config.json）；
 *     - 其余 error 码（`expired_token` / `access_denied` / …）→ 终态，
 *       抛错且消息携带错误码；
 *     - 总超时 = expiresIn 秒（缺省 600）自发起码响应起算 → 抛 expired。
 *
 * 平台侧端点属 spec §7.7（另立 plan，本任务时点尚不存在）——本模块按
 * 下方 Zod schema 的客户端单方契约先行落地，测试全 mock（fetch 可注入）。
 * 端点统一口径（0.1.1 裁定）：全部平台端点落在 `${apiBase}/api/...` 前缀下
 *（与 setup 的 `/api/mecha/devices` 同一拼法；0.1.0 的 `/auth/device/...`
 * 缺 `/api` 前缀是已修 bug）。所有响应 JSON；fetch 为 node 内建，零新增
 * 第三方依赖（zod 与 protocol 同版本，schema 校验自 protocol 层惯例）。
 */

/** POST /api/auth/device/code 响应（interval / expiresIn 单位秒；缺省 5s / 600s）。 */
const DeviceCodeResponseSchema = z.object({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
  expiresIn: z.number().positive().default(600),
  interval: z.number().positive().default(5),
});

/** 轮询成功响应（200）。 */
const TokenSuccessSchema = z.object({
  deviceId: z.string().min(1),
  deviceToken: z.string().min(1),
});

/** 轮询错误体（`{ error: '<code>' }`——pending/slow_down 继续等,其余终态）。 */
const PollErrorSchema = z.object({ error: z.string().min(1) });

/** slow_down 退避封顶（R20 裁定）。 */
const MAX_INTERVAL_MS = 30_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 跑完整 device flow，兑现 `{ deviceId, deviceToken }`。fetchImpl 可注入
 * （测试 mock）；print 可注入（测试收集，缺省 console.log）。
 */
export async function runDeviceFlow(
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
  print: (s: string) => void = console.log,
): Promise<{ deviceId: string; deviceToken: string }> {
  const base = apiBase.replace(/\/+$/, '');

  /** 统一 POST JSON：accept: application/json；响应体必须 JSON。 */
  const postJson = async (
    path: string,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch (err) {
      throw new Error(`device flow: ${path} 响应非 JSON（status ${res.status}）`, {
        cause: err,
      });
    }
    return { status: res.status, body: parsed };
  };

  // ① 发起：拿 deviceCode + 用户操作指引
  const init = await postJson('/api/auth/device/code', {});
  if (init.status !== 200) {
    throw new Error(`device flow: /api/auth/device/code 失败（status ${init.status}）`);
  }
  const codeParsed = DeviceCodeResponseSchema.safeParse(init.body);
  if (!codeParsed.success) {
    throw new Error('device flow: /api/auth/device/code 响应形状非法');
  }
  const { deviceCode, userCode, verificationUri, expiresIn, interval } = codeParsed.data;
  print(`请在浏览器打开: ${verificationUri}  然后输入代码: ${userCode}`);

  // ② 轮询：interval 秒一拍;slow_down 加倍封顶 30s;总超时 expiresIn 秒
  let intervalMs = interval * 1000;
  const deadlineMs = Date.now() + expiresIn * 1000;
  for (;;) {
    await sleep(intervalMs);
    if (Date.now() >= deadlineMs) {
      throw new Error('device flow: expired（授权码已过期,请重新发起 device flow）');
    }
    const poll = await postJson('/api/auth/device/token', { deviceCode });
    const errParsed = PollErrorSchema.safeParse(poll.body);
    if (errParsed.success) {
      if (errParsed.data.error === 'authorization_pending') continue;
      if (errParsed.data.error === 'slow_down') {
        intervalMs = Math.min(intervalMs * 2, MAX_INTERVAL_MS);
        continue;
      }
      // 终态（expired_token / access_denied / …）：错误码原样上抛
      throw new Error(`device flow: ${errParsed.data.error}`);
    }
    if (poll.status !== 200) {
      throw new Error(`device flow: /api/auth/device/token 失败（status ${poll.status}）`);
    }
    const okParsed = TokenSuccessSchema.safeParse(poll.body);
    if (!okParsed.success) {
      throw new Error('device flow: /api/auth/device/token 响应形状非法');
    }
    return okParsed.data;
  }
}
