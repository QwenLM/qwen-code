/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { McpInfo } from '../mcp/tools/mcp-tool.js';
import type { Part } from '@google/genai';
import type {
  AnyDeclarativeTool,
  AnyToolInvocation,
  DiffStat,
  ToolConfirmationOutcome,
  ToolResultDisplay,
  ToolLiveOutput,
} from '../tools/tools.js';
import type { ToolErrorType } from '../tools/tool-error.js';
import type { SerializableConfirmationDetails } from '../tools/confirmation-details.js';
import type { ToolDenialKind } from '../protocol/schemas/common.js';
import type { ToolResultMessage } from '../tools/tool-result-message.js';
import type { ToolPermissionDecision } from '../protocol/schemas/common.js';


import type { McpResultMeta } from '../mcp/tools/mcp-result.js';

export const ROOT_TOOL_CALL_SCOPE_ID = 'root';

/** Execution evidence, independent of whether the tool returned an error. */
export type ToolSettlement = 'completed' | 'not_started' | 'unknown';

/**
 * Internal core statuses for the tool call state machine.
 */
export enum CoreToolCallStatus {
  Validating = 'validating',
  Scheduled = 'scheduled',
  Error = 'error',
  Success = 'success',
  Executing = 'executing',
  Cancelled = 'cancelled',
  AwaitingApproval = 'awaiting_approval',
}

export interface ToolCallRequestInfo {
  /** Original MCP identity for display only. */
  mcpInfo?: McpInfo;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  /**
   * The original name and arguments of the tool requested by the model.
   * This is used for tail calls to ensure the final response and log retains
   * the original values.
   */
  originalRequestName?: string;
  originalRequestArgs?: Record<string, unknown>;
  prompt_id: string;
  requestId?: string;
  isWorkflowAgent?: boolean;
  message_id?: string;
  traceId?: string;
  parentCallId?: string;
  toolCallScopeId?: string;
  inputModifiedByHook?: boolean;
  /** A CodeMode image({path}) read: the host shows the image, so programmatic Read may return one. */
  hostImageRead?: boolean;
  /** Host-only measured PreToolUse text queued for this invocation (not billed Tokens). */
  preHookContextChars?: number;
  forcedAsk?: boolean;
}

export interface ToolCallResponseInfo {
  /** Native result for CodeMode host observers, outside the model response. */
  hostResult?: import('../protocol/schemas/sdk-message.js').SDKCodeModeHostResult;
  callId: string;
  responseParts: Part[];
  resultDisplay: ToolResultDisplay | undefined;
  error: Error | undefined;
  errorType: ToolErrorType | undefined;
  outputFile?: string | undefined;
  contentLength?: number;
  /**
   * Optional data payload for passing structured information back to the caller.
   */
  data?: Record<string, unknown>;
  /**
   * Structured tool output used by UI renderers and persisted in transcripts.
   */
  toolUseResult?: unknown;
  /** Host-only MCP result metadata, never projected into model content. */
  mcpMeta?: McpResultMeta;
  /** Host-only actual Read path when a hook replaced its output. */
  readOutputReplacement?: string;
  /** Propagated from `ToolResult.repeatNeutral`; set on success only. */
  repeatNeutral?: boolean;
  /**
   * File edit line/char deltas, carried separately from `resultDisplay`.
   *
   * `resultDisplay` is only populated for Agent tools (it drives UI rendering
   * and is projected into SDK events), so it cannot carry the diff stats of
   * Edit / Write / NotebookEdit. This field is display-neutral and is the
   * single source for `tool_invoked.lines_added` / `lines_removed`.
   */
  diffStat?: DiffStat;
  /**
   * Semantic-error flag propagated from `ToolResult.isError`. The tool
   * call still carries Success status (responseParts are real handler
   * content), but downstream consumers translate this into
   * `tool_result.is_error = true`.
   */
  isError?: boolean;
  /** Stable permission denial status propagated from the execution gate. */
  toolDenialKind?: ToolDenialKind;
  /** 原始用户拒绝反馈；仅由真实的人类确认界面设置。 */
  userFeedback?: string;
  /** Structured permission reason metadata propagated from the execution gate. */
  decisionReasonType?: ToolPermissionDecision['decisionReasonType'];
  decisionReason?: string;
}

export type ValidatingToolCall = {
  status: CoreToolCallStatus.Validating;
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation?: AnyToolInvocation;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  toolCallScopeId?: string;
  /**
   * Whether plan mode was active when this call was scheduled.
   *
   * This used to be `permissionMode`, compared against `'plan'` downstream — but
   * `plan` was never one of the permission modes (default/acceptEdits/auto/dontAsk/
   * yolo), so that comparison could not be true and the rule it guarded silently
   * stopped working. Plan mode is orthogonal state, so it is carried as its own
   * boolean.
   */
  planModeActive?: boolean;
};

export type ScheduledToolCall = {
  status: CoreToolCallStatus.Scheduled;
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  toolCallScopeId?: string;
  /**
   * Whether plan mode was active when this call was scheduled.
   *
   * This used to be `permissionMode`, compared against `'plan'` downstream — but
   * `plan` was never one of the permission modes (default/acceptEdits/auto/dontAsk/
   * yolo), so that comparison could not be true and the rule it guarded silently
   * stopped working. Plan mode is orthogonal state, so it is carried as its own
   * boolean.
   */
  planModeActive?: boolean;
};

export type ErroredToolCall = {
  status: CoreToolCallStatus.Error;
  request: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  tool?: AnyDeclarativeTool;
  durationMs?: number;
  startTime?: number;
  endTime?: number;
  outcome?: ToolConfirmationOutcome;
  toolCallScopeId?: string;
  /**
   * Whether plan mode was active when this call was scheduled.
   *
   * This used to be `permissionMode`, compared against `'plan'` downstream — but
   * `plan` was never one of the permission modes (default/acceptEdits/auto/dontAsk/
   * yolo), so that comparison could not be true and the rule it guarded silently
   * stopped working. Plan mode is orthogonal state, so it is carried as its own
   * boolean.
   */
  planModeActive?: boolean;
  settlement?: ToolSettlement;
  resultMessages?: ToolResultMessage[];
};

export type SuccessfulToolCall = {
  status: CoreToolCallStatus.Success;
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  response: ToolCallResponseInfo;
  invocation: AnyToolInvocation;
  durationMs?: number;
  startTime?: number;
  endTime?: number;
  outcome?: ToolConfirmationOutcome;
  toolCallScopeId?: string;
  /**
   * Whether plan mode was active when this call was scheduled.
   *
   * This used to be `permissionMode`, compared against `'plan'` downstream — but
   * `plan` was never one of the permission modes (default/acceptEdits/auto/dontAsk/
   * yolo), so that comparison could not be true and the rule it guarded silently
   * stopped working. Plan mode is orthogonal state, so it is carried as its own
   * boolean.
   */
  planModeActive?: boolean;
  settlement?: ToolSettlement;
  resultMessages?: ToolResultMessage[];
};

export type ExecutingToolCall = {
  status: CoreToolCallStatus.Executing;
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  liveOutput?: ToolLiveOutput;
  progressMessage?: string;
  progressPercent?: number;
  progress?: number;
  progressTotal?: number;
  startTime?: number;
  /** Timestamp when execution actually began, excluding validation/approval. */
  executionStartedAt?: number;
  outcome?: ToolConfirmationOutcome;
  pid?: number;
  toolCallScopeId?: string;
  /**
   * Whether plan mode was active when this call was scheduled.
   *
   * This used to be `permissionMode`, compared against `'plan'` downstream — but
   * `plan` was never one of the permission modes (default/acceptEdits/auto/dontAsk/
   * yolo), so that comparison could not be true and the rule it guarded silently
   * stopped working. Plan mode is orthogonal state, so it is carried as its own
   * boolean.
   */
  planModeActive?: boolean;
};

export type CancelledToolCall = {
  status: CoreToolCallStatus.Cancelled;
  request: ToolCallRequestInfo;
  response: ToolCallResponseInfo;
  tool?: AnyDeclarativeTool;
  invocation?: AnyToolInvocation;
  durationMs?: number;
  startTime?: number;
  endTime?: number;
  outcome?: ToolConfirmationOutcome;
  toolCallScopeId?: string;
  /**
   * Whether plan mode was active when this call was scheduled.
   *
   * This used to be `permissionMode`, compared against `'plan'` downstream — but
   * `plan` was never one of the permission modes (default/acceptEdits/auto/dontAsk/
   * yolo), so that comparison could not be true and the rule it guarded silently
   * stopped working. Plan mode is orthogonal state, so it is carried as its own
   * boolean.
   */
  planModeActive?: boolean;
  settlement?: ToolSettlement;
  resultMessages?: ToolResultMessage[];
};

export type WaitingToolCall = {
  status: CoreToolCallStatus.AwaitingApproval;
  request: ToolCallRequestInfo;
  tool: AnyDeclarativeTool;
  invocation: AnyToolInvocation;
  confirmationDetails: SerializableConfirmationDetails;
  correlationId: string;
  startTime?: number;
  outcome?: ToolConfirmationOutcome;
  toolCallScopeId?: string;
  /**
   * Whether plan mode was active when this call was scheduled.
   *
   * This used to be `permissionMode`, compared against `'plan'` downstream — but
   * `plan` was never one of the permission modes (default/acceptEdits/auto/dontAsk/
   * yolo), so that comparison could not be true and the rule it guarded silently
   * stopped working. Plan mode is orthogonal state, so it is carried as its own
   * boolean.
   */
  planModeActive?: boolean;
};

export type Status = ToolCall['status'];

export type ToolCall =
  | ValidatingToolCall
  | ScheduledToolCall
  | ErroredToolCall
  | SuccessfulToolCall
  | ExecutingToolCall
  | CancelledToolCall
  | WaitingToolCall;

export type CompletedToolCall =
  | SuccessfulToolCall
  | CancelledToolCall
  | ErroredToolCall;

export type ConfirmHandler = (
  toolCall: WaitingToolCall,
) => Promise<ToolConfirmationOutcome>;

export type OutputUpdateHandler = (
  toolCallId: string,
  outputChunk: ToolLiveOutput,
) => void;

export type AllToolCallsCompleteHandler = (
  completedToolCalls: CompletedToolCall[],
) => Promise<void>;

export type ToolCallsUpdateHandler = (toolCalls: ToolCall[]) => void;
