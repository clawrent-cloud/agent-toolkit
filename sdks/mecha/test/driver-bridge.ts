import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Mecha } from '@clawrent/protocol';
import type { MechaChannel } from '@clawrent/provider';
import { MECHA_PACKAGE_VERSION } from '../src/constants.js';
import { waitFor, type DriverInbound, type MockRelay } from './mock-relay.js';

/**
 * MechaDriver ↔ mock relay 桥（plan Task 24；R3 通道抽象 + R26 裁定）。
 *
 * 平台中继的测试替身：把驾驶侧（MechaChannel 上的 ClawRentMessage 包络）与
 * 机甲侧（mock relay 的 FakeDriver 设备通道）按 R26 双向适配——
 *
 *  - 出站（驱动 → 机甲）：MechaDriver 发的是 `{type:'mecha.op', payload: op
 *    信封}` / `{type:'mecha.confirmResult', payload: {requestId, approved}}`
 *    包络；机甲 socket（daemon 的 DeviceClient 形状分流）要**裸** op 信封 /
 *    裸批复。桥剥壳后经 `driver.sendOp` / `driver.sendDown`（既有 wire 面）
 *    直达机甲 socket。
 *  - 入站（机甲 → 驱动）：op 族上行（opResult/execChunk/confirmRequest，R16
 *    双族的另一半）经 `driver.onMechaMessage` 到桥，包成 ClawRentMessage 包络
 *    `{type:'mecha.opResult'|…, payload}` 交给 `channel.onMessage` 的订阅者
 *    （即 MechaDriver）。
 *  - `mecha.manifest`：平台在收到机甲 `session.accept` 上行后向驱动推送能力
 *    清单（spec §9——清单是 attach 回执）。mock relay 的 v0 wire 上有机甲侧
 *    无清单上行帧，桥（= 平台替身）以 offer 上下文（policy + sessionId）+
 *    spec §5.6 即焚区布局合成，等待 frameLog 里该 session 的 accept 落地后
 *    推送——时序与平台一致（accept 处理完毕才可能受理 op）。
 *
 * 生命周期：attachTo(relay) 绑定路由与 accept 观测；断链重启 relay 的场景
 * （T24 ③）对**新** relay 再调一次 attachTo 即重绑（通道订阅保持在
 * MechaDriver 侧，不随 relay 更换丢失）。
 */

export interface DriverBridge {
  /** 驾驶侧通道（交给 MechaDriver 构造 opts.channel）。 */
  channel: MechaChannel;
  /** 绑定一台 mock relay：路由出站、转发 op 族上行、观测 accept 推 manifest。
   * 断链重启后对新 relay 再调一次即完成重绑（每台 relay 恰调一次）。 */
  attachTo(relay: MockRelay): void;
}

/** op 族上行的包络 type（分型口径同 daemon.test.ts 的 inbox 收集）。 */
function inboundTypeOf(msg: DriverInbound): string {
  if ('stream' in msg) return 'mecha.execChunk';
  if ('requestId' in msg) return 'mecha.confirmRequest';
  return 'mecha.opResult';
}

export function createDriverBridge(): DriverBridge {
  const cbs = new Set<(msg: unknown) => void>();
  /** 当前绑定的 relay（attachTo latest-wins——断链重启场景重绑新 relay）。 */
  let bound: MockRelay | null = null;
  /** 会话上下文（包络 sessionId 戳 + manifest 合成），随 offer 更新。 */
  let currentSessionId = '';
  let mechaAgentId = 'mecha';
  /** 上一台 relay 的 op 族上行订阅（重绑时退订，防旧 relay 残帧双投递）。 */
  let unsubscribe: (() => void) | null = null;

  const deliver = (msg: unknown): void => {
    for (const cb of cbs) {
      try {
        cb(msg);
      } catch {
        // 订阅者故障不炸桥（平台中继同口径——单会话路由不因一侧坏回调中断）
      }
    }
  };

  /** ClawRentMessage 兼容包络（机甲→驱动方向；sender role 'mecha'）。 */
  const envelope = (type: string, payload: unknown): unknown => ({
    id: randomUUID(),
    sessionId: currentSessionId,
    timestamp: Date.now(),
    sender: { role: 'mecha', agentId: mechaAgentId },
    type,
    payload,
  });

  /** 包一层 offer：捕获 offer 上下文，等该 session 的 accept 上行落地后推
   * mecha.manifest（平台时序）。offer 被拒（无 accept）→ waitFor 超时拒绝
   * → 吸收——无 manifest 即 attach 未成立，与平台语义一致。 */
  const wireManifestPush = (relay: MockRelay): void => {
    const driver = relay.driver;
    const originalOffer = driver.offer.bind(driver);
    driver.offer = (policy, sessionId, driverAgentId) => {
      originalOffer(policy, sessionId, driverAgentId);
      currentSessionId = sessionId;
      void waitFor(() =>
        relay.frameLog.find(
          (f) => f.type === 'session.accept' && f.sessionId === sessionId,
        ),
      )
        .then(() => {
          const hello = relay.frameLog.find((f) => f.type === 'device.hello');
          if (hello !== undefined) mechaAgentId = hello.deviceId;
          const base = policy.dirs[0];
          if (base === undefined) return; // 空 dirs 的 offer 不会被 accept——防御
          deliver(
            envelope('mecha.manifest', {
              sessionId,
              policy,
              mechaVersion: hello?.mechaVersion ?? MECHA_PACKAGE_VERSION,
              // spec §5.6 / session.ts 同一布局：首白名单目录下的会话即焚区
              scratchDir: join(base, '.clawrent', 'scratch', sessionId),
            }),
          );
        })
        .catch(() => {
          // 无 accept（busy 拒 / relay 已关）——不推 manifest
        });
    };
  };

  return {
    channel: {
      send(message: unknown): void {
        if (bound === null) {
          throw new Error('driver bridge: channel.send before attachTo()');
        }
        if (typeof message !== 'object' || message === null) {
          throw new Error('driver bridge: outbound message must be an object');
        }
        const msg = message as Record<string, unknown>;
        // R26 出站适配：包络剥壳 → 裸 op 信封 / 裸批复 → 机甲 socket
        if (msg['type'] === 'mecha.op') {
          bound.driver.sendOp(msg['payload'] as Mecha.MechaOpEnvelope);
          return;
        }
        if (msg['type'] === 'mecha.confirmResult') {
          bound.driver.sendDown(msg['payload']);
          return;
        }
        throw new Error(
          `driver bridge: unroutable outbound message type ${String(msg['type'])}`,
        );
      },
      onMessage(cb: (msg: unknown) => void): void {
        cbs.add(cb);
      },
    },
    attachTo(relay: MockRelay): void {
      bound = relay;
      unsubscribe?.();
      // R26 入站适配：op 族上行 → ClawRentMessage 包络 → 驱动订阅者
      unsubscribe = relay.driver.onMechaMessage((msg: DriverInbound) => {
        deliver(envelope(inboundTypeOf(msg), msg));
      });
      wireManifestPush(relay);
    },
  };
}
