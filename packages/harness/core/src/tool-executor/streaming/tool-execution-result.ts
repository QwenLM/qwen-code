/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolCallRequestInfo,
  ToolSettlement,
} from '../types.js';
import type {
  AnyDeclarativeTool,
  AnyToolInvocation,
  ToolResult,
} from '../../tools/tools.js';
import type { ToolResultMessage } from '../../tools/tool-result-message.js';
import type { ToolDenialKind } from '../../protocol/schemas/common.js';
import type { ToolPermissionDecision } from '../../protocol/schemas/common.js';

export interface ToolExecutionResult {
  settlement?: ToolSettlement;
  /** The request that was executed. */
  readonly request: ToolCallRequestInfo;
  /** The tool definition used, or undefined if unknown tool. */
  readonly tool: AnyDeclarativeTool | undefined;
  /** The invocation used for execution, if successfully built. */
  readonly invocation: AnyToolInvocation | undefined;
  /** The raw ToolResult from invocation.execute(), or undefined on error/cancel. */
  readonly result: ToolResult | undefined;
  /** Error if execution failed. */
  readonly error: Error | undefined;
  /** Whether the tool was cancelled (abort signal). */
  readonly cancelled: boolean;
  /** Duration in ms from start to completion. */
  readonly durationMs: number;

  /**
   * Ordered messages for conversation history injection.
   * Produced by ToolUseResultBuilder, carrying tool_result + hook context +
   * newMessages + stop messages in deterministic order.
   *
   * When undefined, the consumer falls back to constructing a single
   * tool_result from `result.llmContent` (backward compatible).
   */
  readonly resultMessages?: ToolResultMessage[];
  /** Stable permission denial status, when execution stopped at the gate. */
  readonly toolDenialKind?: ToolDenialKind;
  /** 原始用户拒绝反馈；仅由权限交互边界提供。 */
  readonly userFeedback?: string;
  /** Structured permission reason metadata, when execution stopped at the gate. */
  readonly decisionReasonType?: ToolPermissionDecision['decisionReasonType'];
  readonly decisionReason?: string;
}
