/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  BridgeManagedRuntimeToolExecuteResult,
  BridgeManagedRuntimeToolManifest,
} from '@qwen-code/acp-bridge/bridgeTypes';

export const MANAGED_RUNTIME_PROTOCOL_VERSION = 1 as const;

export interface ManagedRuntimePrepareRequest {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workspaceCwd: string;
  readonly sessionId: string;
  readonly turnKind: 'bootstrap' | 'continuation';
}

export interface ManagedRuntimeReadyResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly ready: true;
}

export interface ManagedRuntimeManifestResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly manifest: BridgeManagedRuntimeToolManifest;
}

export interface ManagedRuntimeExecuteResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly result: BridgeManagedRuntimeToolExecuteResult;
}

export interface ManagedRuntimeCancelResponse {
  readonly protocolVersion: typeof MANAGED_RUNTIME_PROTOCOL_VERSION;
  readonly cancelled: boolean;
}

export function sameManagedRuntimeIdentity(
  left: ManagedRuntimePrepareRequest,
  right: ManagedRuntimePrepareRequest,
): boolean {
  return (
    left.tenantId === right.tenantId &&
    left.workspaceId === right.workspaceId &&
    left.workspaceCwd === right.workspaceCwd &&
    left.sessionId === right.sessionId
  );
}
