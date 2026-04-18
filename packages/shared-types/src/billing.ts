export type PricingModel = 'per_session' | 'per_minute' | 'per_token';
export type BillingStatus = 'pending' | 'settled' | 'disputed' | 'refunded';
export type TransactionType = 'recharge' | 'payment' | 'income' | 'refund';

export interface PricingConfig {
  model: PricingModel;
  amount: number;
  currency: string;
}

export interface BillingRecord {
  id: string;
  sessionId: string;
  consumerUserId: string;
  providerUserId: string;
  amount: number;
  platformFee: number;
  providerIncome: number;
  pricingModel: PricingModel;
  meteringData: Record<string, unknown>;
  status: BillingStatus;
  createdAt: Date;
}

export interface WalletTransaction {
  id: string;
  userId: string;
  type: TransactionType;
  amount: number;
  balanceAfter: number;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  createdAt: Date;
}
