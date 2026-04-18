export type PermissionCategory = 'system' | 'file' | 'network' | 'application';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface Permission {
  id: string;
  name: string;
  category: PermissionCategory;
  riskLevel: RiskLevel;
  description: string;
}

export interface GrantedPermission {
  permissionId: string;
  granted: boolean;
  constraints?: {
    commandWhitelist?: string[];
    pathWhitelist?: string[];
    rateLimit?: number;
    maxFileSize?: number;
    networkWhitelist?: string[];
  };
}
