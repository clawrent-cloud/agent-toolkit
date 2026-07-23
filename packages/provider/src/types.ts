import type { GuardrailDecision } from '@clawrent/protocol';

export interface ActiveSession {
  sessionId: string;
  sessionToken: string;
  taskDescription?: string;
  consumerUserId?: string;
  slotIndex?: number;
  /** 平台护栏决策(R3b/R1,来自 session.new 事件):block/advisory/未设置 */
  guardrailDecision?: GuardrailDecision;
  /** /ws/group 模式(Plan 4b):服务端在 system.connected 握手里分配的 participantId。
   *  缺省(undefined)= /ws/session 模式或握手尚未到达。 */
  participantId?: string;
}

export interface SessionSummary {
  sessionId: string;
  status: string;
  taskDescription?: string;
  consumerUserId?: string;
}

export interface SessionDiff {
  newPending: SessionSummary[];
  activated: SessionSummary[];
  ended: SessionSummary[];
}
