/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface OmniStorageQuarantineConfig {
  retentionDays: number;
  maxBytes: number;
}

export interface OmniStorageConfig {
  retentionDays: number;
  maxTotalBytes: number;
  partRetentionHours: number;
  quarantine: OmniStorageQuarantineConfig;
}

export const DEFAULT_OMNI_STORAGE_CONFIG: OmniStorageConfig = {
  retentionDays: 14,
  maxTotalBytes: 21_474_836_480, // 20 GiB
  partRetentionHours: 48,
  quarantine: {
    retentionDays: 7,
    maxBytes: 5_368_709_120, // 5 GiB
  },
};

const MANAGED_ID_PREFIX = 'sha256:';
const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ManagedId = string;

export function hashToManagedId(sha256: string): ManagedId {
  return `${MANAGED_ID_PREFIX}${sha256}`;
}

export function managedIdToHash(managedId: ManagedId): string {
  if (!managedId.startsWith(MANAGED_ID_PREFIX)) {
    throw new Error(`Invalid managedId format: ${managedId}`);
  }
  const hash = managedId.slice(MANAGED_ID_PREFIX.length);
  if (!SHA256_HEX.test(hash)) {
    throw new Error(`Invalid managedId hash: ${managedId}`);
  }
  return hash;
}

export interface CommitResult {
  managedId: ManagedId;
  sha256: string;
  objectPath: string;
  deduplicated: boolean;
  sizeBytes: number;
}

export interface PromoteResult {
  objects: CommitResult[];
}

export interface QuarantineReason {
  invocationId: string;
  tool?: string;
  policyId?: string;
  reason: string;
  timestamp: string;
}

/**
 * Pluggable root-set provider for GC. When Memory is implemented, it will
 * supply the set of managedIds referenced by active records. Until then,
 * callers can provide an empty set or a session-scoped registry.
 */
export interface GcRootProvider {
  getReferencedManagedIds(): Promise<Set<ManagedId>>;
}

export interface GcResult {
  sweptCount: number;
  sweptBytes: number;
  retainedCount: number;
  retainedBytes: number;
  overBudget: boolean;
  budgetWarning?: string;
}

export interface RecoveryResult {
  stagingDirsRemoved: number;
  partFilesRemoved: number;
  quarantineEntriesRemoved: number;
  tmpFilesRemoved: number;
  hashMismatches: string[];
}

export interface BudgetStatus {
  totalBytes: number;
  maxTotalBytes: number;
  objectCount: number;
  overBudget: boolean;
  quarantineBytes: number;
  quarantineMaxBytes: number;
  quarantineOverBudget: boolean;
}

export interface UploadCacheEntry {
  ossUrl: string;
  uploadedAt: string;
  expiresAt: string;
}

export interface OmniStoragePaths {
  objectsDir: string;
  downloadsDir: string;
  stagingDir: string;
  quarantineDir: string;
}
