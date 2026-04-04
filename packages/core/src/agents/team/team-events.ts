/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Typed event emitter for team coordination events.
 *
 * Follows the ArenaEventEmitter pattern: typed wrapper around
 * EventEmitter with a discriminated event map.
 */

import { EventEmitter } from 'events';
import type { AgentStatus } from '../runtime/agent-types.js';
import type {
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from '../../tools/tools.js';

// ─── Event Types ────────────────────────────────────────────

export enum TeamEventType {
  /** A teammate has been spawned and is ready. */
  TEAMMATE_JOINED = 'teammate_joined',
  /** A teammate transitioned to IDLE. */
  TEAMMATE_IDLE = 'teammate_idle',
  /** A teammate's status changed. */
  TEAMMATE_STATUS_CHANGE = 'teammate_status_change',
  /** A teammate has exited (terminal status). */
  TEAMMATE_EXITED = 'teammate_exited',
  /** A message was sent to a teammate. */
  MESSAGE_SENT = 'message_sent',
  /** A task was auto-claimed by an idle teammate. */
  TASK_AUTO_CLAIMED = 'task_auto_claimed',
  /** All teammates have reached terminal status. */
  ALL_TEAMMATES_TERMINATED = 'all_teammates_terminated',
  /** A teammate tool approval could not be forwarded via the
   *  in-memory bridge (headless). The payload carries enough
   *  context for a CLI-level handler to resolve the approval
   *  through the session's own permission channel. */
  TEAMMATE_APPROVAL_REQUEST = 'teammate_approval_request',
}

// ─── Event Payloads ─────────────────────────────────────────

export interface TeammateJoinedEvent {
  agentId: string;
  name: string;
  color?: string;
  timestamp: number;
}

export interface TeammateIdleEvent {
  agentId: string;
  name: string;
  timestamp: number;
}

export interface TeammateStatusChangeEvent {
  agentId: string;
  name: string;
  previousStatus: AgentStatus;
  newStatus: AgentStatus;
  timestamp: number;
}

export interface TeammateExitedEvent {
  agentId: string;
  name: string;
  status: AgentStatus;
  timestamp: number;
}

export interface MessageSentEvent {
  from: string;
  to: string;
  message: string;
  timestamp: number;
}

export interface TaskAutoClaimedEvent {
  agentId: string;
  name: string;
  taskId: string;
  taskSubject: string;
  timestamp: number;
}

export interface AllTeammatesTerminatedEvent {
  timestamp: number;
}

export interface TeammateApprovalRequestEvent {
  /** Name of the teammate requesting approval. */
  teammateName: string;
  /** Tool that needs approval. */
  toolName: string;
  /** Tool input parameters (for display). */
  toolInput: Record<string, unknown>;
  /** Callback to resolve the approval. */
  respond: (
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) => Promise<void>;
  timestamp: number;
}

// ─── Event Map ──────────────────────────────────────────────

export interface TeamEventMap {
  [TeamEventType.TEAMMATE_JOINED]: TeammateJoinedEvent;
  [TeamEventType.TEAMMATE_IDLE]: TeammateIdleEvent;
  [TeamEventType.TEAMMATE_STATUS_CHANGE]: TeammateStatusChangeEvent;
  [TeamEventType.TEAMMATE_EXITED]: TeammateExitedEvent;
  [TeamEventType.MESSAGE_SENT]: MessageSentEvent;
  [TeamEventType.TASK_AUTO_CLAIMED]: TaskAutoClaimedEvent;
  [TeamEventType.ALL_TEAMMATES_TERMINATED]: AllTeammatesTerminatedEvent;
  [TeamEventType.TEAMMATE_APPROVAL_REQUEST]: TeammateApprovalRequestEvent;
}

// ─── Event Emitter ──────────────────────────────────────────

export class TeamEventEmitter {
  private ee = new EventEmitter();

  on<E extends keyof TeamEventMap>(
    event: E,
    listener: (payload: TeamEventMap[E]) => void,
  ): void {
    this.ee.on(event, listener as (...args: unknown[]) => void);
  }

  off<E extends keyof TeamEventMap>(
    event: E,
    listener: (payload: TeamEventMap[E]) => void,
  ): void {
    this.ee.off(event, listener as (...args: unknown[]) => void);
  }

  emit<E extends keyof TeamEventMap>(event: E, payload: TeamEventMap[E]): void {
    this.ee.emit(event, payload);
  }

  once<E extends keyof TeamEventMap>(
    event: E,
    listener: (payload: TeamEventMap[E]) => void,
  ): void {
    this.ee.once(event, listener as (...args: unknown[]) => void);
  }

  removeAllListeners(): void {
    this.ee.removeAllListeners();
  }
}
