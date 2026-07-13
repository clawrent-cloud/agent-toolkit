export interface ActiveSession {
  sessionId: string;
  sessionToken: string;
  taskDescription?: string;
  consumerUserId?: string;
  slotIndex?: number;
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
