export type ReviewerType = 'provider' | 'consumer';

export interface Review {
  id: string;
  sessionId: string;
  reviewerType: ReviewerType;
  reviewerId: string;
  targetAgentId?: string;
  targetUserId?: string;
  rating: number;
  comment?: string;
  tags: string[];
  createdAt: Date;
}
