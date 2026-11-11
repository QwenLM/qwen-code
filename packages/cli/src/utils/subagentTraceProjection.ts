/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CODE_MODE_RESULT_TYPE,
  CoreToolCallStatus,
  checkExhaustive,
  normalizeToolInput,
  isRecord,
  type Message,
  type SubagentActivityItem,
} from '@qwen-code/core';
import {
  projectToolCallDisplay,
  type ToolResultDisplaySource,
} from '../ui/utils/toolDisplayProjection.js';
import type { IndividualToolCallDisplay } from '../ui/types.js';

export type SubagentToolActivityStatus = Extract<
  SubagentActivityItem['status'],
  'running' | 'completed' | 'error' | 'cancelled'
>;

interface CodeModeReceipt {
  type: typeof CODE_MODE_RESULT_TYPE;
  cellId: string;
  calls: unknown[];
  callsMode?: string;
}

function isCodeModeReceipt(value: unknown): value is CodeModeReceipt {
  if (!isRecord(value)) return false;
  const receipt = value as Partial<CodeModeReceipt>;
  return (
    receipt.type === CODE_MODE_RESULT_TYPE &&
    typeof receipt.cellId === 'string' &&
    Array.isArray(receipt.calls)
  );
}

export function collectSubagentToolResults(
  messages: readonly Message[],
): Map<string, ToolResultDisplaySource> {
  const resultsByToolUseId = new Map<string, ToolResultDisplaySource>();

  for (const message of messages) {
    if (message.type !== 'user' || !Array.isArray(message.message.content)) {
      continue;
    }

    const toolResultBlocks = message.message.content.filter(
      (block): block is typeof block & { type: 'tool_result' } =>
        block.type === 'tool_result',
    );
    if (toolResultBlocks.length === 0) {
      continue;
    }

    if (toolResultBlocks.length === 1) {
      const block = toolResultBlocks[0];
      resultsByToolUseId.set(block.tool_use_id, {
        content: block.content,
        isError: block.is_error === true,
        toolUseResult: message.toolUseResult,
      });
      continue;
    }

    const structuredResults = Array.isArray(message.toolUseResult)
      ? message.toolUseResult
      : [];
    for (let i = 0; i < toolResultBlocks.length; i++) {
      const block = toolResultBlocks[i];
      resultsByToolUseId.set(block.tool_use_id, {
        content: block.content,
        isError: block.is_error === true,
        toolUseResult:
          i < structuredResults.length ? structuredResults[i] : undefined,
      });
    }
  }

  // Older CodeMode receipts persisted cumulative calls on every poll. Scope
  // deduplication to this projection so rewinds and other sessions start fresh.
  const cells = new Map<string, Map<string, string>>();
  for (const [id, result] of resultsByToolUseId) {
    const data = result.toolUseResult;
    if (!isCodeModeReceipt(data)) continue;
    const seen = cells.get(data.cellId) ?? new Map<string, string>();
    cells.set(data.cellId, seen);
    const calls = data.calls.filter((call) => {
      if (!isRecord(call)) return true;
      const callId = call['callId'];
      if (typeof callId !== 'string') return true;
      const fingerprint = JSON.stringify(call);
      const changed = seen.get(callId) !== fingerprint;
      seen.set(callId, fingerprint);
      return data.callsMode === 'delta' || changed;
    });
    if (data.callsMode !== 'delta')
      resultsByToolUseId.set(id, {
        ...result,
        toolUseResult: { ...data, calls, totalCalls: data.calls.length },
      });
  }
  return resultsByToolUseId;
}

export function projectSubagentRecentActivity(
  messages: readonly Message[],
  options: { targetDir?: string } = {},
): SubagentActivityItem[] {
  const activity: SubagentActivityItem[] = [];
  const toolResults = collectSubagentToolResults(messages);
  for (const message of messages) {
    if (message.type === 'assistant') {
      for (const block of message.message.content) {
        if (block.type !== 'tool_use') {
          continue;
        }

        const toolResult = toolResults.get(block.id);
        activity.push(
          projectSubagentToolActivity({
            id: block.id,
            name: block.name,
            input: normalizeToolInput(block.input),
            toolResult,
            status: getActivityStatus(toolResult),
            targetDir: options.targetDir,
          }),
        );
      }
      continue;
    }

    if (message.type === 'system' && message.subtype === 'compact_boundary') {
      activity.push({
        id: message.uuid,
        type: 'compact',
        content: 'Conversation compacted',
        status: 'completed',
        preTokens: message.compactMetadata?.preTokens,
        postTokens: message.compactMetadata?.postTokens,
      });
    }
  }

  return activity;
}

export function projectSubagentToolActivity(args: {
  id: string;
  name: string;
  input: Record<string, unknown>;
  toolResult?: ToolResultDisplaySource;
  status?: SubagentToolActivityStatus;
  targetDir?: string;
}): SubagentActivityItem {
  const projected = projectToolCallDisplay({
    toolUse: {
      id: args.id,
      name: args.name,
      input: args.input,
    },
    toolResult: args.toolResult,
    runtime: {
      status: toCoreToolCallStatus(
        args.status ?? getActivityStatus(args.toolResult),
      ),
      targetDir: args.targetDir,
    },
  });

  return {
    id: args.id,
    type: 'tool_call',
    content: args.name,
    displayName: projected.name,
    description: projected.description,
    args: projected.description
      ? JSON.stringify({ description: projected.description })
      : undefined,
    toolInput: args.input,
    toolResult: args.toolResult
      ? {
          ...args.toolResult,
          content: args.toolResult.content ?? '',
        }
      : undefined,
    status: args.status ?? getActivityStatus(args.toolResult),
  };
}

export function projectSubagentToolCalls(
  message: Extract<Message, { type: 'assistant' }>,
  toolResults: ReadonlyMap<string, ToolResultDisplaySource>,
  options: { targetDir?: string } = {},
): IndividualToolCallDisplay[] {
  return message.message.content.flatMap((block) => {
    if (block.type !== 'tool_use') {
      return [];
    }

    const toolResult = toolResults.get(block.id);
    return projectToolCallDisplay({
      toolUse: {
        id: block.id,
        name: block.name,
        input: normalizeToolInput(block.input),
      },
      toolResult,
      runtime: {
        status: toCoreToolCallStatus(getActivityStatus(toolResult)),
        targetDir: options.targetDir,
      },
    });
  });
}

export function getActivityStatus(
  toolResult: ToolResultDisplaySource | undefined,
): SubagentToolActivityStatus {
  if (!toolResult) {
    return 'running';
  }
  return toolResult.isError ? 'error' : 'completed';
}

function toCoreToolCallStatus(
  status: SubagentToolActivityStatus,
): CoreToolCallStatus {
  switch (status) {
    case 'running':
      return CoreToolCallStatus.Executing;
    case 'completed':
      return CoreToolCallStatus.Success;
    case 'error':
      return CoreToolCallStatus.Error;
    case 'cancelled':
      return CoreToolCallStatus.Cancelled;
    default:
      return checkExhaustive(status);
  }
}
