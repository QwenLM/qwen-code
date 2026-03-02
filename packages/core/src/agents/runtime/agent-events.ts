/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Agent event types, emitter, and lifecycle hooks.
 *
 * Defines the observation/notification contracts for the agent runtime:
 * - Event types emitted during agent execution (streaming, tool calls, etc.)
 * - AgentEventEmitter — typed wrapper around EventEmitter
 * - Lifecycle hooks (pre/post tool use, stop) for synchronous callbacks
 */

import { EventEmitter } from 'events';
import type {
  ToolCallConfirmationDetails,
  ToolConfirmationOutcome,
  ToolResultDisplay,
} from '../../tools/tools.js';
import type { Part, GenerateContentResponseUsageMetadata } from '@google/genai';
import type { AgentStatus } from './agent-types.js';

// ─── Event Types ────────────────────────────────────────────

export type AgentEvent =
  | 'start'
  | 'round_start'
  | 'round_end'
  | 'round_text'
  | 'stream_text'
  | 'tool_call'
  | 'tool_result'
  | 'tool_output_update'
  | 'tool_waiting_approval'
  | 'usage_metadata'
  | 'finish'
  | 'error'
  | 'status_change';

export enum AgentEventType {
  START = 'start',
  ROUND_START = 'round_start',
  ROUND_END = 'round_end',
  /** Complete round text, emitted once after streaming before tool calls. */
  ROUND_TEXT = 'round_text',
  STREAM_TEXT = 'stream_text',
  TOOL_CALL = 'tool_call',
  TOOL_RESULT = 'tool_result',
  TOOL_OUTPUT_UPDATE = 'tool_output_update',
  TOOL_WAITING_APPROVAL = 'tool_waiting_approval',
  USAGE_METADATA = 'usage_metadata',
  FINISH = 'finish',
  ERROR = 'error',
  STATUS_CHANGE = 'status_change',
}

// ─── Event Payloads ─────────────────────────────────────────

export interface AgentStartEvent {
  subagentId: string;
  name: string;
  model?: string;
  tools: string[];
  timestamp: number;
}

export interface AgentRoundEvent {
  subagentId: string;
  round: number;
  promptId: string;
  timestamp: number;
}

export interface AgentRoundTextEvent {
  subagentId: string;
  round: number;
  text: string;
  thoughtText: string;
  timestamp: number;
}

export interface AgentStreamTextEvent {
  subagentId: string;
  round: number;
  text: string;
  /** Whether this text is reasoning/thinking content (as opposed to regular output) */
  thought?: boolean;
  timestamp: number;
}

export interface AgentUsageEvent {
  subagentId: string;
  round: number;
  usage: GenerateContentResponseUsageMetadata;
  durationMs?: number;
  timestamp: number;
}

export interface AgentToolCallEvent {
  subagentId: string;
  round: number;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  description: string;
  /** Whether the tool's output should be rendered as markdown. */
  isOutputMarkdown?: boolean;
  timestamp: number;
}

export interface AgentToolResultEvent {
  subagentId: string;
  round: number;
  callId: string;
  name: string;
  success: boolean;
  error?: string;
  responseParts?: Part[];
  resultDisplay?: ToolResultDisplay;
  /** Path to the temp file where oversized output was saved. */
  outputFile?: string;
  durationMs?: number;
  timestamp: number;
}

export interface AgentToolOutputUpdateEvent {
  subagentId: string;
  round: number;
  callId: string;
  /** Latest accumulated output for this tool call (replaces previous). */
  outputChunk: ToolResultDisplay;
  /** PTY process PID — present when the tool runs in an interactive shell. */
  pid?: number;
  timestamp: number;
}

export interface AgentApprovalRequestEvent {
  subagentId: string;
  round: number;
  callId: string;
  name: string;
  description: string;
  confirmationDetails: Omit<ToolCallConfirmationDetails, 'onConfirm'> & {
    type: ToolCallConfirmationDetails['type'];
  };
  respond: (
    outcome: ToolConfirmationOutcome,
    payload?: Parameters<ToolCallConfirmationDetails['onConfirm']>[1],
  ) => Promise<void>;
  timestamp: number;
}

export interface AgentFinishEvent {
  subagentId: string;
  terminateReason: string;
  timestamp: number;
  rounds?: number;
  totalDurationMs?: number;
  totalToolCalls?: number;
  successfulToolCalls?: number;
  failedToolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AgentErrorEvent {
  subagentId: string;
  error: string;
  timestamp: number;
}

export interface AgentStatusChangeEvent {
  agentId: string;
  previousStatus: AgentStatus;
  newStatus: AgentStatus;
  timestamp: number;
}

// ─── Event Map ──────────────────────────────────────────────

/**
 * Maps each event type to its payload type for type-safe emit/on.
 */
export interface AgentEventMap {
  [AgentEventType.START]: AgentStartEvent;
  [AgentEventType.ROUND_START]: AgentRoundEvent;
  [AgentEventType.ROUND_END]: AgentRoundEvent;
  [AgentEventType.ROUND_TEXT]: AgentRoundTextEvent;
  [AgentEventType.STREAM_TEXT]: AgentStreamTextEvent;
  [AgentEventType.TOOL_CALL]: AgentToolCallEvent;
  [AgentEventType.TOOL_RESULT]: AgentToolResultEvent;
  [AgentEventType.TOOL_OUTPUT_UPDATE]: AgentToolOutputUpdateEvent;
  [AgentEventType.TOOL_WAITING_APPROVAL]: AgentApprovalRequestEvent;
  [AgentEventType.USAGE_METADATA]: AgentUsageEvent;
  [AgentEventType.FINISH]: AgentFinishEvent;
  [AgentEventType.ERROR]: AgentErrorEvent;
  [AgentEventType.STATUS_CHANGE]: AgentStatusChangeEvent;
}

// ─── Event Emitter ──────────────────────────────────────────

export class AgentEventEmitter {
  private ee = new EventEmitter();

  on<E extends keyof AgentEventMap>(
    event: E,
    listener: (payload: AgentEventMap[E]) => void,
  ): void {
    this.ee.on(event, listener as (...args: unknown[]) => void);
  }

  off<E extends keyof AgentEventMap>(
    event: E,
    listener: (payload: AgentEventMap[E]) => void,
  ): void {
    this.ee.off(event, listener as (...args: unknown[]) => void);
  }

  emit<E extends keyof AgentEventMap>(
    event: E,
    payload: AgentEventMap[E],
  ): void {
    this.ee.emit(event, payload);
  }
}

// ─── Lifecycle Hooks ────────────────────────────────────────

export interface PreToolUsePayload {
  subagentId: string;
  name: string; // subagent name
  toolName: string;
  args: Record<string, unknown>;
  timestamp: number;
}

export interface PostToolUsePayload extends PreToolUsePayload {
  success: boolean;
  durationMs: number;
  errorMessage?: string;
}

export interface AgentStopPayload {
  subagentId: string;
  name: string; // subagent name
  terminateReason: string;
  summary: Record<string, unknown>;
  timestamp: number;
}

export interface AgentHooks {
  preToolUse?(payload: PreToolUsePayload): Promise<void> | void;
  postToolUse?(payload: PostToolUsePayload): Promise<void> | void;
  onStop?(payload: AgentStopPayload): Promise<void> | void;
}
