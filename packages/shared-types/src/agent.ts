export type AgentStatus = 'draft' | 'pending_review' | 'active' | 'suspended';
export type HostingType = 'self_hosted' | 'platform_hosted';
export type TransparencyLevel = 'opaque' | 'moderate' | 'transparent';
export type ApprovalMode = 'manual' | 'auto_rules' | 'open';
export type VerificationLevel = 'unverified' | 'platform_tested' | 'community_certified';
export type OnlineStatus = 'online' | 'offline' | 'busy';

export interface AgentCapability {
  id: string;
  agentId: string;
  category: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentVersion {
  version: string;
  status: 'active' | 'beta' | 'deprecated' | 'archived';
  changelog: string;
  publishedAt: Date;
}

export interface RegisteredAgent {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description: string;
  longDescription?: string;

  capabilities: AgentCapability[];

  pricingModel: string;
  priceAmount: number;
  currency: string;

  hostingType: HostingType;
  endpoint?: string;
  healthCheckUrl?: string;

  transparencyLevel: TransparencyLevel;
  approvalMode: ApprovalMode;
  maxConcurrentSessions: number;

  status: AgentStatus;
  verificationLevel: VerificationLevel;
  onlineStatus: OnlineStatus;

  totalSessions: number;
  avgRating: number;
  completionRate: number;

  createdAt: Date;
  updatedAt: Date;
}
