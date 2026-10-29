/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ManagedSessionCommitProof } from './managed-session-storage.js';
import type { ManagedSessionKey } from './managed-session-records.js';

export interface HostedHarnessPlacement {
  readonly instanceId: string;
  readonly bootId: string;
  readonly placementEpoch: number;
}

export interface HostedHarnessReleaseRequest extends HostedHarnessPlacement {
  readonly operationId: string;
  readonly commitProof: ManagedSessionCommitProof;
}

export interface HostedHarnessReleaseReceipt
  extends HostedHarnessReleaseRequest,
    ManagedSessionKey {
  readonly format: 'qwen-hosted-harness-release/1';
  readonly writerGeneration: number;
  readonly journalRevision: number;
  readonly committedSequence: number;
  readonly state: 'RELEASED';
}
