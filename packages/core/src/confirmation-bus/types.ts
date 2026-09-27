/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCall } from '@google/genai';
import type {
  ToolConfirmationOutcome,
  ToolConfirmationPayload,
} from '../tools/tools.js';

export enum MessageBusType {
  TOOL_CONFIRMATION_REQUEST = 'tool-confirmation-request',
  TOOL_CONFIRMATION_RESPONSE = 'tool-confirmation-response',
  TOOL_EXECUTION_SUCCESS = 'tool-execution-success',
  TOOL_EXECUTION_FAILURE = 'tool-execution-failure',
  HOOK_EXECUTION_REQUEST = 'hook-execution-request',
  HOOK_EXECUTION_RESPONSE = 'hook-execution-response',
  HOOK_PROGRESS = 'hook-progress',
}

export interface ToolConfirmationRequest {
  type: MessageBusType.TOOL_CONFIRMATION_REQUEST;
  toolCall: FunctionCall;
  correlationId: string;
  serverName?: string;
  /**
   * Optional rich details for the confirmation UI (diffs, counts, etc.)
   */
  details?: SerializableConfirmationDetails;
}

export interface ToolConfirmationResponse {
  type: MessageBusType.TOOL_CONFIRMATION_RESPONSE;
  correlationId: string;
  confirmed: boolean;
  /**
   * The specific outcome selected by the user.
   *
   * TODO: Make required after migration.
   */
  outcome?: ToolConfirmationOutcome;
  /**
   * Optional payload (e.g., modified content for 'modify_with_editor').
   */
  payload?: ToolConfirmationPayload;
  /**
   * When true, indicates that policy decision was ASK_USER and the tool should
   * show its legacy confirmation UI instead of auto-proceeding.
   */
  requiresUserConfirmation?: boolean;
}

/**
 * Data-only versions of ToolCallConfirmationDetails for bus transmission.
 */
export type SerializableConfirmationDetails =
  | {
      type: 'info';
      title: string;
      prompt: string;
      urls?: string[];
    }
  | {
      type: 'edit';
      title: string;
      fileName: string;
      filePath: string;
      fileDiff: string;
      originalContent: string | null;
      newContent: string;
      isModifying?: boolean;
    }
  | {
      type: 'exec';
      title: string;
      command: string;
      rootCommand: string;
      rootCommands: string[];
      commands?: string[];
    }
  | {
      type: 'mcp';
      title: string;
      serverName: string;
      toolName: string;
      toolDisplayName: string;
    }
  | {
      type: 'exit_plan_mode';
      title: string;
      planPath: string;
    };

export interface ToolExecutionSuccess<T = unknown> {
  type: MessageBusType.TOOL_EXECUTION_SUCCESS;
  toolCall: FunctionCall;
  result: T;
}

export interface ToolExecutionFailure<E = Error> {
  type: MessageBusType.TOOL_EXECUTION_FAILURE;
  toolCall: FunctionCall;
  error: E;
}

export interface HookExecutionRequest {
  type: MessageBusType.HOOK_EXECUTION_REQUEST;
  eventName: string;
  input: Record<string, unknown>;
  correlationId: string;
  /** Optional AbortSignal to cancel hook execution */
  signal?: AbortSignal;
}

export interface HookExecutionResponse {
  type: MessageBusType.HOOK_EXECUTION_RESPONSE;
  correlationId: string;
  success: boolean;
  output?: Record<string, unknown>;
  error?: Error;
  /** Number of stop hooks that were executed */
  stopHookCount?: number;
}

/**
 * How a single hook finished, as reported on {@link HookProgress}.
 * `cancelled` means the user aborted; `timeout` means the hook ran past its
 * own timeout. They are reported separately because a UI tells them apart.
 */
export type HookProgressOutcome =
  | 'success'
  | 'blocked'
  | 'error'
  | 'timeout'
  | 'cancelled';

/**
 * Published once when each hook starts and once when it ends, for every hook
 * event, whether the event was fired directly or through the bus. Purely
 * observational: nothing waits for a subscriber.
 */
export interface HookProgress {
  type: MessageBusType.HOOK_PROGRESS;
  phase: 'start' | 'end';
  /** HookEventName value, e.g. 'PreToolUse'. */
  eventName: string;
  /** Display name: the hook's name, else its command, url, id or prompt. */
  hookName: string;
  hookType: 'command' | 'http' | 'function' | 'prompt';
  /**
   * Opaque id for ONE hook execution: the same value on this hook's `start`
   * and its `end`, unique within the process. Consumers pair the two by it and
   * must never render it: it carries no meaning for a reader.
   */
  invocationId: string;
  /**
   * The subagent whose turn ran this hook, when one did. A subagent's hooks
   * live in the parent registry and publish on the parent bus, so a consumer
   * that writes to a transcript needs this to pick the right one.
   */
  agentId?: string;
  /** 0-based position of this hook inside the event's batch. */
  index: number;
  /** Number of hooks in the event's batch. */
  total: number;
  /** The hook's configured statusMessage, when set. Both phases carry it. */
  statusMessage?: string;
  /** end only. */
  durationMs?: number;
  /** end only. */
  outcome?: HookProgressOutcome;
  /** end only: the error message when the hook failed to run cleanly. */
  error?: string;
  /** end only: a command hook's exit code when its process ran to completion. */
  exitCode?: number;
  /** end only: this hook's own systemMessage, not the aggregated one. */
  systemMessage?: string;
  /** end only: the reason given when outcome is 'blocked'. */
  blockedReason?: string;
  /** end only: true when the hook was handed to the async registry. */
  async?: boolean;
  /**
   * end only: display level that overrides whatever a consumer would derive
   * from `outcome`. Not set by hook execution itself; reserved for replaying
   * async hook output, whose stderr is a warning rather than an error.
   */
  level?: 'info' | 'warning' | 'error';
}

export type Message =
  | ToolConfirmationRequest
  | ToolConfirmationResponse
  | ToolExecutionSuccess
  | ToolExecutionFailure
  | HookExecutionRequest
  | HookExecutionResponse
  | HookProgress;
