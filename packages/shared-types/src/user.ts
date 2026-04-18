export type UserRole = 'provider' | 'consumer' | 'both';
export type UserStatus = 'active' | 'suspended' | 'banned';

export interface User {
  id: string;
  email: string;
  name: string;
  avatarUrl?: string;
  role: UserRole;
  walletBalance: number;
  reputationScore: number;
  status: UserStatus;
  apiKey?: string;
  createdAt: Date;
  updatedAt: Date;
}
