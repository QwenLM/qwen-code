/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelToolUseBlock } from '../provider/event/modelCompleteEvent.js';
import type { ToolResultBlock } from './tool-result.js';

export const TOOL_STREAM_RECOVERY_LIMIT = 2;
export const TERMINAL_TOOL_SETTLEMENT_MS = 5_000;

export const UNDELIVERED_TOOL_NOT_DISPATCHED_RESULT =
  'Error: Tool was not executed because the model response was interrupted before this call was dispatched. Reissue the call if it is still needed.';
export const UNDELIVERED_TOOL_INCOMPLETE_ARGUMENTS_RESULT =
  'Error: Tool was not executed because the model response was interrupted before its arguments were fully received. Reissue the call with complete arguments.';

/**
 * 中断时未投递给执行器的调用：至少要带 id/name，才能在历史里配一条占位
 * tool_result。
 */
export interface UndeliveredToolCall {
  readonly id: string;
  readonly name: string;
  /** 中断前块已闭合，参数是完整的。 */
  readonly argumentsComplete: boolean;
  /** 仅在参数完整且解成对象时存在。 */
  readonly input?: Record<string, unknown>;
}

/**
 * History-only records for calls the interrupted response never dispatched.
 * They exist to keep every tool_use paired with a tool_result; they carry
 * placeholder arguments and must never reach an executor.
 */
export function buildUndeliveredToolRecords(calls: UndeliveredToolCall[]): {
  toolUses: ModelToolUseBlock[];
  toolResults: ToolResultBlock[];
} {
  const toolUses: ModelToolUseBlock[] = [];
  const toolResults: ToolResultBlock[] = [];
  for (const call of calls) {
    toolUses.push({
      type: 'tool_use',
      id: call.id,
      name: call.name,
      input: call.input ?? {},
    });
    toolResults.push({
      type: 'tool_result',
      tool_use_id: call.id,
      is_error: true,
      content: call.argumentsComplete
        ? UNDELIVERED_TOOL_NOT_DISPATCHED_RESULT
        : UNDELIVERED_TOOL_INCOMPLETE_ARGUMENTS_RESULT,
    });
  }
  return { toolUses, toolResults };
}
