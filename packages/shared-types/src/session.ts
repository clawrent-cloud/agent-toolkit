export type SessionStatus =
  | 'pending_approval'
  | 'pending_authorization'
  | 'created'
  | 'active'
  | 'paused'
  | 'checkpoint_saved'
  | 'completed'
  | 'aborted'
  | 'expired'
  | 'settled';

export type SessionType = 'task' | 'persistent';

export interface StepRecord {
  stepIndex: number;
  instructionId: string;
  status: 'completed' | 'failed' | 'skipped';
  result?: unknown;
  timestamp: number;
}

export interface SessionCheckpoint {
  stepIndex: number;
  completedSteps: StepRecord[];
  pendingSteps: StepRecord[];
  collectedContext: Record<string, unknown>;
  savedAt: Date;
}

export interface SessionSlot {
  id: string;
  sessionId: string;
  slotIndex: number;
  consumerAgentId?: string;
  consumerUserId: string;
  status: string;
  assignedAt?: Date;
  connectedAt?: Date;
  disconnectedAt?: Date;
  createdAt: Date;
}

export interface Session {
  id: string;
  providerAgentId: string;
  consumerUserId: string;
  providerUserId: string;

  taskDescription: string;
  status: SessionStatus;
  sessionType: SessionType;
  sessionToken: string;

  maxSlots: number;
  slots?: SessionSlot[];

  checkpoint?: SessionCheckpoint;

  totalInstructions: number;
  totalTokensProvider: number;
  totalTokensConsumer: number;
  totalMessages: number;
  activeDurationMs: number;

  billingAmount?: number;
  platformFee?: number;
  providerIncome?: number;
  billingStatus?: string;

  startedAt?: Date;
  endedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}
