import type { GuardrailDecision } from '@clawrent/protocol';

export interface ActiveSession {
  sessionId: string;
  sessionToken: string;
  taskDescription?: string;
  consumerUserId?: string;
  slotIndex?: number;
  /** 平台护栏决策(R3b/R1,来自 session.new 事件):block/advisory/未设置 */
  guardrailDecision?: GuardrailDecision;
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
