/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export class ManagedRuntimeProviderError extends Error {
  constructor(
    readonly code:
      | 'managed_runtime_identity_conflict'
      | 'managed_runtime_unavailable'
      | 'managed_runtime_disposed'
      | 'managed_runtime_capacity_exhausted',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ManagedRuntimeProviderError';
  }
}
