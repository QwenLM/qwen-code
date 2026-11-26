/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * tool-result-message.ts — Unified carrier for tool execution output
 * destined for conversation history.
 *
 * We use a discriminated union `ToolConversationMessage` for type-safe
 * exhaustive `switch/case` in consumers.
 *
 * Pipeline position:
 *   ToolUseResultBuilder.build() → ToolResultMessage[]
 *     → ToolExecutionResult.resultMessages
 *     → CompletedToolCall.resultMessages
 *     → ToolBridgeExecuteResult.allMessages
 *     → agent-loop conversationMessages
 */

import type { ToolUseContext } from './tool-types.js';
/** 工具结果携带的缓存提示；由会话／请求边界映射到各自契约。 */
export interface ToolResultCacheControl {
  readonly type: 'ephemeral';
  readonly ttl?: string;
}

/** 工具执行／结果收集阶段的文本，不依赖模型请求或 transcript 类型。 */
export interface ToolResultTextPart {
  readonly type: 'text';
  readonly text: string;
  readonly cacheControl?: ToolResultCacheControl;
}

/** 工具执行／结果收集阶段的图片，保留内联数据或 URL 引用。 */
export interface ToolResultImagePart {
  readonly type: 'image';
  readonly source:
    | {
        readonly type: 'base64';
        readonly mediaType: string;
        readonly data: string;
      }
    | {
        readonly type: 'url';
        readonly url: string;
      };
  readonly cacheControl?: ToolResultCacheControl;
}

export type ToolResultContentPart = ToolResultTextPart | ToolResultImagePart;

/** 工具结果总线的正文；落盘与模型请求在各自边界转换。 */
export type ToolResultContent = string | readonly ToolResultContentPart[];

// ---------------------------------------------------------------------------
// ToolResultMessage — the unified result item
// ---------------------------------------------------------------------------

/**
 * A single item in the tool-result stream.
 *
 * Every injection source (tool data, hook context, permission feedback,
 * newMessages) produces one or more of these. They are collected by
 * ToolUseResultBuilder and yielded in a deterministic order.
 */
export interface ToolResultMessage {
  /** The conversation message to write to history. */
  readonly message: ToolConversationMessage;

  /**
   * Optional context modifier piggybacked on this message.
   * Only the tool_result message should carry this.
   */
  readonly contextModifier?: ContextModifierEntry;
}

/**
 * A context modifier attached to a specific tool call.
 *
 * Applied by the STE:
 * - Serial tools: immediately after the tool completes.
 * - Concurrent tools: deferred to after the batch completes.
 */
export interface ContextModifierEntry {
  readonly toolCallId: string;
  readonly modifyContext: (ctx: ToolUseContext) => ToolUseContext;
}

// ---------------------------------------------------------------------------
// ToolConversationMessage — discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all message types that can appear on the
 * tool-result bus. Consumers should `switch` on `type` for exhaustive
 * handling.
 */
export type ToolConversationMessage =
  | ToolResultConversationMessage
  | HookContextConversationMessage
  | SupplementaryConversationMessage
  | StopConversationMessage;

/**
 * The primary tool_result — maps 1:1 with a tool_use block.
 * This is the primary data channel.
 */
export interface ToolResultConversationMessage {
  readonly type: 'tool_result';
  readonly toolCallId: string;
  readonly content: ToolResultContent;
  readonly isError: boolean;
}

/**
 * Hook-injected context (pre or post).
 *
 * P2 — reserved for system-reminder wrapping. Currently collected but
 * not consumed by agent-loop.
 *
 */
export interface HookContextConversationMessage {
  readonly type: 'hook_context';
  /** Source identifier, e.g. 'PreToolUse:ReadFile' or 'PostToolUse:Bash'. */
  readonly source: string;
  readonly text: string;
}

/**
 * Extra messages from ToolResult.newMessages.
 *
 * These produce independent messages in conversation history. Images that are
 * part of a tool's result belong in ToolResultConversationMessage instead.
 *
 */
export interface SupplementaryConversationMessage {
  readonly type: 'supplementary';
  readonly content: ToolResultContent;
}

/**
 * Hook/system requested stop — instructs the agent loop to cease
 * further LLM inference after processing the current batch.
 *
 */
export interface StopConversationMessage {
  readonly type: 'stop';
  readonly reason: string;
}
