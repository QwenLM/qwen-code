/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WorkspaceRuntime } from './workspace-registry.js';

export const MANAGED_RUNTIME_STARTUP_MS = 5 * 60_000;
export const MANAGED_LEASE_ID_HEADER = 'X-Qwen-Managed-Lease-Id';
export const MANAGED_LEASE_EPOCH_HEADER = 'X-Qwen-Managed-Lease-Epoch';

export interface ManagedRuntimeScope {
  readonly tenantId: string;
  readonly runtime: WorkspaceRuntime;
}
export interface ManagedWorkerBoot {
  readonly type: 'boot';
  readonly cliEntry: string;
  readonly version: 1;
  readonly gatewayIncarnation: string;
  readonly leaseId: string;
  readonly epoch: number;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workspaceCwd: string;
  readonly token: string;
  readonly outputRoot: string;
}
export interface ManagedRuntimeEndpoint {
  readonly url: string;
  readonly boot: ManagedWorkerBoot;
  readonly deadline: number;
}
export type RuntimeFinishReason = 'completed' | 'failed' | 'cancelled';
export class ManagedRuntimeReleasedError extends Error {}
export interface ManagedRuntimeUse {
  readonly endpoint: Promise<ManagedRuntimeEndpoint>;
  readonly signal: AbortSignal;
  readonly exited: Promise<void>;
  release(reason: RuntimeFinishReason): void;
  beginOperation(): (certain: boolean) => void;
}
