/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const MANAGED_SESSION_LIMITS = {
  maxIdBytes: 512,
  // Not frozen by the storage spec: a bound for free-form enum-adjacent fields
  // such as `source` or `stopReason`, borrowed from its error-message cap.
  maxTextBytes: 4096,
  maxTimeMs: 8_640_000_000_000_000,
  maxJsonDepth: 64,
  maxHeaderBytes: 64 * 1024,
  maxEventBytes: 1024 * 1024,
  maxCommitMarkerBytes: 64 * 1024,
  maxTransactionEvents: 256,
  maxTransactionBytes: 8 * 1024 * 1024,
  defaultReadEvents: 100,
  maxReadEvents: 256,
} as const;

export class ManagedSessionRecordError extends Error {
  readonly code: string = 'managed_session_invalid_record';

  constructor(message: string) {
    super(message);
    this.name = 'ManagedSessionRecordError';
  }
}
