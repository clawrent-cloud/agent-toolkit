import { describe, it, expect } from 'vitest';
import {
  StaffInboundFrameSchema, StaffOutboundFrameSchema, StaffTaskResultFrameSchema, StaffTaskPayloadSchema,
  type StaffTaskPayload,
} from './messages';

const TASK: StaffTaskPayload = {
  id: 't1', actionId: 'agent.review', source: 'manual', targetType: 'agent', targetId: 'a1',
  params: { note: 'x' }, retryCount: 0, createdAt: '2026-09-21T00:00:00.000Z', expiresAt: null,
};

describe('staff frames 0.5.0', () => {
  it('result frame requires reasoning + proposedAction', () => {
    expect(() => StaffTaskResultFrameSchema.parse({ type: 'staff.task_result', taskId: 't1' })).toThrow();
    expect(StaffTaskResultFrameSchema.parse({
      type: 'staff.task_result', taskId: 't1', reasoning: 'why',
      proposedAction: { targetType: 'agent', targetId: 'a1', params: { decision: 'approve' } },
    })).toBeTruthy();
  });
  it('inbound union discriminates four types', () => {
    for (const f of [
      { type: 'staff.task_ack', taskId: 't1' },
      { type: 'staff.task_error', taskId: 't1', message: 'boom' },
      { type: 'staff.query', queryId: 'q1', queryType: 'user.view' },
    ]) expect(StaffInboundFrameSchema.safeParse(f).success).toBe(true);
  });
  it('outbound union covers hello/snapshot/task/query_response', () => {
    expect(StaffTaskPayloadSchema.safeParse(TASK).success).toBe(true);
    expect(StaffOutboundFrameSchema.safeParse({ type: 'staff.hello', staffId: 's', displayName: 'd', department: 'g', grants: [{ actionId: 'a', autonomy: 'advisory' }] }).success).toBe(true);
    expect(StaffOutboundFrameSchema.safeParse({ type: 'staff.tasks_snapshot', tasks: [TASK] }).success).toBe(true);
    expect(StaffOutboundFrameSchema.safeParse({ type: 'staff.task', task: TASK }).success).toBe(true);
    expect(StaffOutboundFrameSchema.safeParse({ type: 'staff.query_response', queryId: 'q1', data: {} }).success).toBe(true);
  });
  it('responseLanguage 字段:additive——带字段 parse 通过且保留,不带(parse 旧 payload)也通过', () => {
    const withLang = StaffTaskPayloadSchema.safeParse({ ...TASK, responseLanguage: 'zh-CN' });
    expect(withLang.success).toBe(true);
    expect((withLang.data as Record<string, unknown>)['responseLanguage']).toBe('zh-CN');
    // 旧 payload(无字段)兼容:fixture 本身即无该字段
    expect(StaffTaskPayloadSchema.safeParse(TASK).success).toBe(true);
  });
  it('query_response accepts error variant', () => {
    expect(StaffOutboundFrameSchema.safeParse({ type: 'staff.query_response', queryId: 'q1', error: 'denied' }).success).toBe(true);
  });
});
