/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgePromptContentBlock } from './acp-session-bridge.js';

interface ManagedPromptRequestBase {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly prompt: readonly BridgePromptContentBlock[];
  readonly deadlineAt?: number;
}

export interface ManagedGatewayPromptRequest extends ManagedPromptRequestBase {
  readonly mode: 'gateway';
  readonly turnKind: 'bootstrap' | 'continuation';
  readonly workspaceCwd: string;
  readonly managedClientId: string;
}

export type ManagedPromptRequest = ManagedGatewayPromptRequest;

export interface ManagedPromptAdmissionResponse {
  readonly created: boolean;
  readonly state: 'admitted' | 'processing' | 'finished';
  readonly activationReady: boolean;
}

export interface ManagedPromptStatus {
  readonly messageId: string;
  readonly state: 'admitted' | 'processing' | 'finished';
  readonly activationReady: boolean;
  readonly admittedAt: number;
  readonly outcome?: 'completed' | 'failed' | 'cancelled';
  readonly cancelRequested?: boolean;
  readonly finishedAt?: number;
}

export interface ManagedGatewaySessionBinding {
  readonly tenantId: string;
  readonly workspaceId: string;
  readonly workspaceCwd: string;
  readonly sessionId: string;
  readonly managedClientId: string;
}

export interface ManagedPromptService {
  start?(): Promise<void>;
  admit(request: ManagedPromptRequest): Promise<ManagedPromptAdmissionResponse>;
  getStatus(
    tenantId: string,
    sessionId: string,
    messageId: string,
  ): ManagedPromptStatus | undefined;
  getGatewayBinding?(
    sessionId: string,
  ): ManagedGatewaySessionBinding | undefined;
  canContinue?(sessionId: string): boolean;
  cancel?(sessionId: string, messageId: string): Promise<boolean>;
  dispose(): void;
}

export class ManagedPromptServiceError extends Error {
  constructor(
    readonly code:
      | 'managed_prompt_inbox_full'
      | 'managed_prompt_tenant_inbox_full'
      | 'managed_prompt_idempotency_conflict'
      | 'managed_prompt_deadline_exceeded'
      | 'managed_prompt_recovery_ambiguous'
      | 'managed_prompt_payload_invalid'
      | 'managed_gateway_turn_active',
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ManagedPromptServiceError';
  }
}
