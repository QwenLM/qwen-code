/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentStatus } from '../runtime/agent-types.js';
import type { SerializableConfirmationDetails } from '../../confirmation-bus/types.js';
import type {
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from '../../tools/tools.js';

export type TurnId = string;
export type AgentSessionKind = 'in-process' | 'supervised';

export interface AgentSession {
  readonly agentId: string;
  readonly teamId: string;
  readonly kind: AgentSessionKind;

  getStatus(): AgentStatus;
  getError(): string | undefined;
  send(message: string): Promise<TurnId>;
  cancelTurn(): void;
  abort(): void;
  on<E extends keyof AgentSessionEvents>(
    event: E,
    handler: (payload: AgentSessionEvents[E]) => void,
  ): () => void;
}

export interface AgentSessionEvents {
  status: {
    previous: AgentStatus;
    next: AgentStatus;
    turnId?: TurnId;
    cancelledByUser?: boolean;
  };
  turnText: { turnId: TurnId; text: string };
  approvalRequest: ApprovalRequest;
  toolActivity: {
    turnId: TurnId;
    phase: 'call' | 'result';
    toolName: string;
    callId: string;
  };
  exited: { code: number | null; reason: string };
}

export interface ApprovalRequest {
  callId: string;
  turnId: TurnId;
  agentId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  details: SerializableConfirmationDetails;
}

export interface ApprovalDecision {
  callId: string;
  outcome: ToolConfirmationOutcome;
  payload?: ToolConfirmationPayload;
}
