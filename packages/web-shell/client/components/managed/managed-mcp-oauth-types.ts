import type { components } from './generated/managed-agent-api';

export interface ManagedMcpOAuthRequirement {
  type: 'oauth';
  providerId: string;
  resourceUri: string;
  scopes: string[];
}

export type ManagedMcpOAuthServer =
  components['schemas']['ManagedMcpOAuthServer'];
export type ManagedMcpOAuthSnapshot =
  components['schemas']['ManagedMcpOAuthQueryResult'];
export type ManagedMcpOAuthStart =
  components['schemas']['ManagedMcpOAuthStartResult'];

export interface ManagedMcpOAuthAttempt {
  attemptId: string;
  authorizationUrl?: string;
  expiresAt?: number;
  state:
    | 'pending'
    | 'code_received'
    | 'exchanging'
    | 'completed'
    | 'failed'
    | 'expired';
  credentialId?: string;
  generation?: number;
}

export type ManagedMcpOAuthRevocation =
  components['schemas']['ManagedMcpOAuthRevokeResult'];
