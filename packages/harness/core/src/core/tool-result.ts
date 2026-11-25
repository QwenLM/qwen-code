/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 工具执行结果的共享类型：模型侧 block、权限拒绝与 preflight 结果。
 */

import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';
import type {
  ToolResultContent,
  ToolResultMessage,
} from '../tools/tool-result-message.js';
import type {
  ToolDenialKind,
  ToolPermissionDenialKind,
} from '../protocol/schemas/common.js';
import type { McpResultMeta } from '../mcp/tools/mcp-result.js';
import type { DiffStat } from '../tools/tools.js';
import type { ToolSettlement } from '../tool-executor/types.js';
export type { ToolSettlement } from '../tool-executor/types.js';

// ---------------------------------------------------------------------------
// 工具执行结果：使用工具域独立内容契约，在会话／请求边界转换
// ---------------------------------------------------------------------------

/**
 * 工具执行结束后的主结果；正文属于工具域，不是落盘或推理请求载荷。
 *
 * Emitted by the tool executor and consumed by the AgentLoop to build the
 * next user message in the conversation history.
 *
 * `toolUseResult` carries the structured execution payload persisted
 * alongside the flattened tool_result content.
 */
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: ToolResultContent;
  is_error: boolean;
  toolUseResult?: unknown;
  mcpMeta?: McpResultMeta;
  /** Host-only actual Read path when a hook replaced its output. */
  readOutputReplacement?: string;
  toolDenialKind?: ToolDenialKind;
  userFeedback?: string;
  /**
   * File edit line/char deltas from file-write tools, display-neutral.
   * Mirrors `ToolCallResponseInfo.diffStat`; see its doc for the semantics.
   */
  diffStat?: DiffStat;
}

export interface ToolPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
  message: string;
  tool_denial_kind?: ToolPermissionDenialKind;
  decision_reason_type?:
    | 'rule'
    | 'mode'
    | 'subcommandResults'
    | 'permissionPromptTool'
    | 'hook'
    | 'asyncAgent'
    | 'sandboxOverride'
    | 'workingDir'
    | 'safetyCheck'
    | 'classifier'
    | 'repeatedToolCall'
    | 'other';
  decision_reason?: string;
}

export interface ToolExecutionPreflightDenied {
  allowed: false;
  reason: string;
  terminalReason?: string;
  decisionReasonType?: ToolPermissionDenial['decision_reason_type'];
  decisionReason?: string;
  toolDenialKind?: ToolDenialKind;
}

export type ToolExecutionPreflightResult =
  | { allowed: true; updatedInput?: Record<string, unknown> }
  | ToolExecutionPreflightDenied;

export type ToolExecutionPreflight = (
  block: ModelToolUseBlock,
  signal?: AbortSignal,
) => Promise<ToolExecutionPreflightResult>;

// ---------------------------------------------------------------------------
// ToolBridgeExecuteResult — legacy batch-shape result
// ---------------------------------------------------------------------------

/**
 * Legacy batch-shaped result kept for test fixtures and preflight consumers.
 */
export interface ToolBridgeExecuteResult {
  /** Internal execution evidence, never inferred from is_error. */
  settlement?: ReadonlyMap<string, ToolSettlement>;
  /** Primary tool_result blocks (1:1 with input toolUseBlocks). */
  toolResults: ToolResultBlock[];
  /**
   * All result messages from all tools, in execution order.
   * Includes tool_results + hook contexts + supplementary messages + stops.
   * Empty when no tools produced extra messages.
   */
  allMessages: ToolResultMessage[];
  /** Tool calls denied before execution, for SDK permission_denied events/results. */
  permissionDenials?: ToolPermissionDenial[];
  /** Terminal reason requested by a preflight guard. */
  terminalReason?: string;
  /** 仅运行时使用：具有真实完成证据的工具结果 ID。 */
  confirmedToolResultIds?: ReadonlySet<string>;
  /** Runtime-only: successful polls to remove from repeated-call detection. */
  repeatNeutralToolResultIds?: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
