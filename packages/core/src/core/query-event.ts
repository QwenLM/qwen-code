/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelMessage } from '../provider/event/modelCompleteEvent.js';
import type { ModelInferenceErrorKind } from '../provider/modelInferenceError.js';
import type { McpInfo } from '../mcp/tools/mcp-tool.js';
import type {
  ModelStopReason,
  ModelStreamEvent,
} from '../provider/event/modelStreamEvent.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { Message } from '../protocol/transcript/message.js';

export const CONTENT_FILTERED_MESSAGE =
  "Sorry, I'm unable to answer this question for now. Let's change the topic!";

export interface RequestStartEvent {
  type: 'request_start';
}

export interface StreamEvent {
  type: 'stream_event';
  event: ModelStreamEvent;
  /** 宿主请求身份，仅由最终协议出口投影。 */
  requestId?: string;
  parent_tool_use_id?: string | null;
  session_id?: string;
}

export interface AssistantBlockEvent {
  type: 'assistant_block';
  message: ModelMessage;
  index: number;
  requestId?: string;
  /** 执行前捕获的 MCP 原始身份，属于宿主，不进入模型块。 */
  mcpToolIdentities?: Record<string, McpInfo>;
}

export interface ErrorNotificationEvent {
  type: 'error_notification';
  error_type: string;
  message: string;
  status_code?: number;
  error_source?: string;
  error_code?: string;
  error_message?: string;
  error_details?: ErrorNotificationDetails;
  model?: string;
  timestamp: string;
}

export interface ErrorNotificationDetails {
  source?: string;
  name?: string;
  message?: string;
  code?: string;
  normalized_code?: ModelInferenceErrorKind;
  /** Present on new model errors. A null value represents an unknown source. */
  provider_source?: string | null;
  status_code?: number;
  transport?: string;
  retryable?: boolean;
}

export interface ResultTextResetEvent {
  type: 'result_text_reset';
  reason: 'malformed_tool_use_retry';
}

export type CommandLifecycleState =
  | 'queued'
  | 'started'
  | 'completed'
  | 'cancelled'
  | 'discarded';

/**
 * Runtime delivery state for a UUID-stamped queued command.
 *
 * `uuid` identifies the queued command. The SDK stream projection renames it
 * to `command_uuid` and adds a separate event UUID plus the session envelope.
 * This event is not persisted in the conversation transcript.
 */
export interface CommandLifecycleEvent {
  type: 'command_lifecycle';
  uuid: string;
  state: CommandLifecycleState;
}

export type QueryEvent =
  | RequestStartEvent
  | StreamEvent
  | AssistantBlockEvent
  | ErrorNotificationEvent
  | ResultTextResetEvent
  | CommandLifecycleEvent
  | Message;

export function isDurableQueryEvent(event: QueryEvent): event is Message {
  return (
    event.type !== 'request_start' &&
    event.type !== 'stream_event' &&
    event.type !== 'assistant_block' &&
    event.type !== 'error_notification' &&
    event.type !== 'result_text_reset' &&
    event.type !== 'command_lifecycle'
  );
}

export interface Terminal {
  reason:
    | 'end_turn'
    | 'max_turns'
    | 'abort'
    | 'error'
    | 'repeated_tool_call_denied';
  error?: Error;
  /** Model-level stop reason, distinct from the agent-loop execution result. */
  modelStopReason?: ModelStopReason;
  requestId?: string;
  clientRequestId?: string;
  serverRequestId?: string;
  numTurns: number;
  usage: NonNullableUsage;
  durationMs: number;
  /** Correlation metadata populated by the Agent loop for downstream consumers. */
  requestSetId?: string;
  /** Detailed interrupt phase exposed as SDK result `terminal_reason`. */
  abortKind?: 'aborted_streaming' | 'aborted_tools';
  /** Hook 主动结束本轮的原因，同时暴露为 SDK result 的 terminal_reason。 */
  terminalDetail?: 'hook_stopped';
  /** Hook 返回的 stopReason 原文，用于在 result 中保留阻断原因。 */
  hookStopReason?: string;
}
