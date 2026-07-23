/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type MemoryScope = 'personal' | 'repository';

export type RuntimeCapability =
  | 'context:read'
  | 'events:write'
  | 'memory:read'
  | 'proposal:write'
  | 'feedback:write';

export interface RuntimeIdentity {
  tenantId: string;
  principalId: string;
  workspaceId: string;
  repositoryId: string;
  revocationEpoch: number;
}

export interface ProtectedContent {
  ciphertext: string;
  keyHandle: string;
}

export type MemoryLifecycleState =
  | 'candidate'
  | 'active'
  | 'rejected'
  | 'superseded'
  | 'expired'
  | 'tombstoned';

export type ErasureState = 'live' | 'pending_erasure' | 'erased';

export type FeedbackSignal = 'helpful' | 'not_helpful' | 'stale' | 'unsafe';

export type DeletionReason =
  | 'user_request'
  | 'maintainer_request'
  | 'candidate_rejected'
  | 'retention_expired'
  | 'tenant_offboarding';

export interface CanonicalMemoryRecord {
  id: string;
  tenantId: string;
  scope: MemoryScope;
  scopeId: string;
  protectedContent: ProtectedContent;
  authority: string;
  lifecycleState: MemoryLifecycleState;
  erasureState: ErasureState;
  version: number;
  sourceOperationId: string;
  sourceFingerprint: string;
  createdAt: Date;
  expiresAt: Date | null;
}

export interface CandidateInput {
  scope: MemoryScope;
  summary: string;
  references: readonly string[];
}

export interface ProviderSearchResult {
  providerMemoryId: string;
  score: number;
}

export interface RecalledMemory {
  id: string;
  scope: MemoryScope;
  authority: string;
  summary: string;
  references: readonly string[];
  score: number;
}

export interface RawEventInput {
  eventId: string;
  sessionId: string;
  turnId?: string;
  eventKind: string;
  occurredAt: Date;
  protectedPayload: ProtectedContent;
  sourceFingerprint: string;
}

export interface ProviderBinding {
  tenantId: string;
  canonicalMemoryId: string;
  canonicalVersion: number;
  providerMemoryId: string;
  scope: MemoryScope;
  entityId: string;
  state: 'active' | 'pending_delete' | 'deleted' | 'failed';
}

export interface PolicySnapshot {
  version: number;
  expiresAt: Date;
  systemContext: string;
}
