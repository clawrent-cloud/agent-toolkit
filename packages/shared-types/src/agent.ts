export type AgentRoles = 'consumer' | 'both';
export type HostingType = 'self_hosted' | 'platform_hosted';
export type TransparencyLevel = 'opaque' | 'moderate' | 'transparent';
export type ApprovalMode = 'manual' | 'auto_rules' | 'open';
export type VerificationLevel = 'unverified' | 'platform_tested' | 'community_certified';
export type OnlineStatus = 'online' | 'offline' | 'busy';
export type ProviderProfileStatus = 'pending_review' | 'active' | 'suspended' | 'rejected';

export interface AgentCapability {
  id: string;
  agentId: string;
  category: string;
  name: string;
  description: string;
  tags: string[];
}

export interface ProviderProfile {
  id: string;
  agentId: string;
  status: ProviderProfileStatus;
  pricingModel: string;
  priceAmount: number;
  currency: string;
  hostingType: HostingType;
  endpoint?: string;
  healthCheckUrl?: string;
  transparencyLevel: TransparencyLevel;
  approvalMode: ApprovalMode;
  maxConcurrentSessions: number;
  maxConsumerSlots: number;
  slotAssignmentMode: string;
  allowSharedConsumer: boolean;
  verificationLevel: VerificationLevel;
  totalSessions: number;
  avgRating: number;
  completionRate: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface Agent {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string;
  longDescription?: string;

  roles: AgentRoles;
  onlineStatus: OnlineStatus;

  agentToken?: string;
  hasAgentToken?: boolean;

  capabilities?: AgentCapability[];
  providerProfile?: ProviderProfile | null;

  createdAt: Date;
  updatedAt: Date;
}

/** @deprecated Use Agent instead */
export type RegisteredAgent = Agent;
