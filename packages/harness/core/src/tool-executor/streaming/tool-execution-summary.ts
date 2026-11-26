/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ToolResultBlock,
  ToolPermissionDenial,
} from '../../core/tool-result.js';
import type { HookAttachment } from '../../attachments/types.js';
import type { UserMessage } from '../../protocol/transcript/message.js';
import type { ToolSettlement } from '../types.js';
import type { ModelToolUseBlock } from '../../provider/event/modelCompleteEvent.js';
import { createToolResultMessage } from '../../protocol/transcript/conversions.js';
import { attachIsHardFailure } from '../../tools/tool-result-hard-failure.js';
import { REPEATED_TOOL_CALL_TERMINAL_REASON } from './repeated-tool-call.js';
import type { ToolCallResult } from '../tool-executor.js';
import { runLogger } from '../../utils/runLogger.js';
import { randomUUID } from 'node:crypto';

export interface ToolExecutionSummaryOptions {
  assistantMessageUuid?: string;
  promptId: string;
  interrupted?: boolean;
  terminalInterruption?: boolean;
}

/** One model response's tool outcomes, already ordered and aggregated. */
export interface ToolExecutionSummary {
  results: ToolCallResult[];
  toolResults: ToolResultBlock[];
  historyMessages: UserMessage[];
  settlements: Map<string, ToolSettlement>;
  permissionDenials: ToolPermissionDenial[];
  terminalReason?: string;
  hookStopAttachment?: HookAttachment;
  hasUnknownOutcomes: boolean;
}

export function summarizeToolExecutions(
  blocks: readonly ModelToolUseBlock[],
  settled: readonly ToolCallResult[],
  options: ToolExecutionSummaryOptions,
): ToolExecutionSummary {
  const byToolUseId = new Map(
    settled.map((result) => [result.block.tool_use_id, result]),
  );
  const assistantUuid = options.assistantMessageUuid ?? randomUUID();
  const results = blocks.map(
    (block) =>
      byToolUseId.get(block.id) ??
      notStartedToolResult(
        block.id,
        options.terminalInterruption
          ? 'Error: Tool was not started because the model stream was interrupted.'
          : 'Error: Tool execution was not started because the tool call was not delivered incrementally.',
        assistantUuid,
        options.promptId,
      ),
  );
  return summarizeResults(results, options.interrupted === true);
}

/**
 * Fills in calls the model produced but never dispatched (non-incremental
 * streams), preserving model order.
 */
export function completeToolExecutions(
  blocks: readonly ModelToolUseBlock[],
  summary: ToolExecutionSummary,
  options: ToolExecutionSummaryOptions,
): ToolExecutionSummary {
  if (summary.results.length === blocks.length) return summary;
  return summarizeToolExecutions(blocks, summary.results, options);
}

export function failedToolExecutions(
  blocks: readonly ModelToolUseBlock[],
  error: unknown,
  cancelled: boolean,
  options: ToolExecutionSummaryOptions,
): ToolExecutionSummary {
  const assistantUuid = options.assistantMessageUuid ?? randomUUID();
  const message = `Error: ${error instanceof Error ? error.message : String(error)}`;
  const results = blocks.map((block) => {
    const resultBlock: ToolResultBlock = {
      type: 'tool_result',
      tool_use_id: block.id,
      content: message,
      is_error: true,
      toolUseResult: attachIsHardFailure(undefined, !cancelled),
      ...(cancelled ? { toolDenialKind: 'interrupted' as const } : {}),
    };
    return {
      block: resultBlock,
      supplementaryMessages: [],
      historyMessage: createToolResultMessage([resultBlock], assistantUuid, {
        promptId: options.promptId,
      }),
      control: { settlement: 'not_started' as const },
    };
  });
  return summarizeResults(results, options.interrupted === true);
}

function summarizeResults(
  results: ToolCallResult[],
  interrupted: boolean,
): ToolExecutionSummary {
  const toolResults = results.map((result) => result.block);
  const settlements = new Map(
    results.map((result) => [
      result.block.tool_use_id,
      result.control.settlement,
    ]),
  );
  const permissionDenials = results.flatMap((result) =>
    result.control.permissionDenial ? [result.control.permissionDenial] : [],
  );
  const terminalReason = results.some(
    (result) =>
      result.control.terminalReason === REPEATED_TOOL_CALL_TERMINAL_REASON,
  )
    ? REPEATED_TOOL_CALL_TERMINAL_REASON
    : undefined;
  const hookStopAttachment = results
    .flatMap((result) => result.control.attachments ?? [])
    .find((attachment) => attachment.type === 'hook_stopped_continuation');
  const hasUnknownOutcomes = results.some(
    (result) => result.control.settlement === 'unknown',
  );

  runLogger.log(
    `[ToolExecutor] Tool execution completed: ${toolResults.length} results`,
  );

  return {
    results,
    toolResults,
    historyMessages: results.map((result) => result.historyMessage),
    settlements,
    permissionDenials,
    terminalReason,
    hookStopAttachment,
    hasUnknownOutcomes: interrupted ? hasUnknownOutcomes : false,
  };
}

function notStartedToolResult(
  toolUseId: string,
  message: string,
  assistantMessageUuid: string,
  promptId: string,
): ToolCallResult {
  const block: ToolResultBlock = {
    type: 'tool_result',
    tool_use_id: toolUseId,
    content: message,
    is_error: true,
    toolUseResult: attachIsHardFailure(undefined, true),
  };
  return {
    block,
    supplementaryMessages: [],
    historyMessage: createToolResultMessage([block], assistantMessageUuid, {
      promptId,
    }),
    control: { settlement: 'not_started' },
  };
}
