/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BridgeEvent } from './eventBus.js';

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function isSummaryReplayEvent(event: BridgeEvent): boolean {
  if (event.type !== 'session_update') return true;
  const data = record(event.data);
  const update = record(data?.['update']) ?? data;
  const meta = record(update?.['_meta']);
  // Match the SDK normalizer: these liveness frames never render a tool card.
  if (
    (update?.['sessionUpdate'] === 'tool_call' ||
      update?.['sessionUpdate'] === 'tool_call_update') &&
    update['status'] === 'in_progress' &&
    typeof update['kind'] !== 'string' &&
    (meta?.['shellProgress'] !== undefined ||
      meta?.['subagentProgress'] === true)
  )
    return false;
  // Self-parented tool frames render as root cards; dropping them would make
  // a visible card disappear after a summary reload.
  const parent = meta?.['parentToolCallId'];
  return (
    typeof parent !== 'string' ||
    parent.length === 0 ||
    parent === update?.['toolCallId']
  );
}

export function summarizeReplayEvent(
  event: BridgeEvent,
): BridgeEvent | undefined {
  if (!isSummaryReplayEvent(event)) return undefined;
  if (event.type !== 'session_update') return event;
  const data = record(event.data);
  const update = record(data?.['update']) ?? data;
  if (!update) return event;
  const meta = record(update['_meta']);
  let projected = update;
  if (
    update['sessionUpdate'] === 'tool_call' ||
    update['sessionUpdate'] === 'tool_call_update'
  ) {
    const output = record(update['rawOutput']);
    const agent =
      output?.['type'] === 'task_execution' ||
      meta?.['toolName'] === 'agent' ||
      meta?.['toolName'] === 'task';
    if (agent) {
      if (output) {
        // A background launch can complete its tool call while the agent is
        // still running. Prefer the task status over the outer tool status.
        const status = output['status'] ?? update['status'];
        const settled =
          status === 'completed' ||
          status === 'failed' ||
          status === 'cancelled';
        const {
          toolCalls: _toolCalls,
          taskPrompt: _taskPrompt,
          tokenCount: _tokenCount,
          ...summary
        } = output;
        const executionSummary = record(summary['executionSummary']);
        if (!settled && executionSummary) {
          const {
            inputTokens: _inputTokens,
            outputTokens: _outputTokens,
            thoughtTokens: _thoughtTokens,
            cachedTokens: _cachedTokens,
            totalTokens: _totalTokens,
            ...stats
          } = executionSummary;
          summary['executionSummary'] = stats;
        }
        projected = {
          ...projected,
          rawOutput: {
            ...summary,
            ...(settled && _tokenCount !== undefined
              ? { tokenCount: _tokenCount }
              : {}),
          },
        };
      }
      const input = record(update['rawInput']);
      if (input && 'prompt' in input) {
        const { prompt: _prompt, ...summary } = input;
        projected = { ...projected, rawInput: summary };
      }
    }
  }
  return projected === update
    ? event
    : {
        ...event,
        data: record(data?.['update'])
          ? { ...data, update: projected }
          : projected,
      };
}

export function summarizeReplay(events: BridgeEvent[]): BridgeEvent[] {
  return events.flatMap((event) => {
    const projected = summarizeReplayEvent(event);
    return projected ? [projected] : [];
  });
}
