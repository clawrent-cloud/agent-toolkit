import { describe, it, expect } from 'vitest';
import { ClawRentMessageSchema } from '../envelope.js';
import { validateMessage } from '../validators.js';
import * as protocol from '../index.js';

/**
 * Task 4 接线集成测试：mecha 帧进入会话消息通道。
 *
 * 信封只做 wire 形状校验（envelope.ts 同一裁定）：type 六值进 MessageType
 * 枚举、sender.role 增 'mecha' 后，机甲设备通道的 op/结果/流块/确认/清单
 * 才能走 ClawRentMessageSchema（session 通道）收发；payload 仍是自由
 * record——op/result/confirm 各帧的形状校验归 mecha/*.ts 对应 schema。
 */

const mechaOpMessage = {
  id: 'msg-mecha-1',
  sessionId: 'sess-1',
  timestamp: 1_760_000_000_000,
  sender: { role: 'mecha', agentId: 'mecha-device-01' },
  type: 'mecha.op',
  payload: {
    opId: 'op-1',
    sessionId: 'sess-1',
    op: { type: 'fs.read', path: 'docs/report.csv', encoding: 'utf8' },
  },
};

describe('mecha ↔ 会话消息接线 (ClawRentMessageSchema)', () => {
  it("type:'mecha.op' + sender.role:'mecha' 解析通过", () => {
    const parsed = ClawRentMessageSchema.parse(mechaOpMessage);
    expect(parsed.type).toBe('mecha.op');
    expect(parsed.sender.role).toBe('mecha');
  });

  it('validateMessage 对 mecha.op 消息不抛', () => {
    expect(() => validateMessage(mechaOpMessage)).not.toThrow();
  });

  it('MessageType 六个 mecha 值均过信封校验', () => {
    for (const type of [
      'mecha.op',
      'mecha.opResult',
      'mecha.execChunk',
      'mecha.confirmRequest',
      'mecha.confirmResult',
      'mecha.manifest',
    ]) {
      expect(
        ClawRentMessageSchema.safeParse({ ...mechaOpMessage, type }).success,
        `${type} 应解析通过`,
      ).toBe(true);
    }
  });

  it('index.ts 以 Mecha 命名空间导出四个 mecha 模块', () => {
    expect(protocol.Mecha).toBeDefined();
    // 四个模块各取一个代表性导出（policy/ops/confirm/frames）。
    expect(protocol.Mecha.MechaPolicySchema).toBeDefined();
    expect(protocol.Mecha.MechaOpSchema).toBeDefined();
    expect(protocol.Mecha.MechaConfirmRequestSchema).toBeDefined();
    expect(protocol.Mecha.MechaDeviceFrameSchema).toBeDefined();
  });
});
