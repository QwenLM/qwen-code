/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Dedicated agent tool call component for structured subagent execution output.
 */

import type { FC } from 'react';
import { ToolCallCard, ToolCallRow, safeTitle } from './shared/index.js';
import type {
  AgentExecutionRawOutput,
  BaseToolCallProps,
  ToolCallData,
} from './shared/index.js';

const MAX_VISIBLE_TOOL_CALLS = 5;

export const isAgentExecutionRawOutput = (
  value: unknown,
): value is AgentExecutionRawOutput =>
  Boolean(
    value &&
      typeof value === 'object' &&
      'type' in value &&
      (value as { type?: unknown }).type === 'task_execution' &&
      'taskDescription' in value &&
      'status' in value,
  );

export const isAgentExecutionToolCall = (
  toolCall: ToolCallData,
): toolCall is ToolCallData & { rawOutput: AgentExecutionRawOutput } =>
  isAgentExecutionRawOutput(toolCall.rawOutput);

const STATUS_LABELS: Record<AgentExecutionRawOutput['status'], string> = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const CHILD_STATUS_LABELS: Record<
  NonNullable<AgentExecutionRawOutput['toolCalls']>[number]['status'],
  string
> = {
  executing: 'Running',
  awaiting_approval: 'Awaiting approval',
  success: 'Completed',
  failed: 'Failed',
};

const formatDuration = (durationMs: number): string => {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 60_000) {
    return `${(durationMs / 1000).toFixed(durationMs % 1000 === 0 ? 0 : 1)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
};

const getHeaderTitle = (
  data: AgentExecutionRawOutput,
  fallbackTitle: ToolCallData['title'],
): string => data.taskDescription || safeTitle(fallbackTitle) || 'Agent Task';

export const AgentToolCall: FC<BaseToolCallProps> = ({ toolCall }) => {
  if (!isAgentExecutionToolCall(toolCall)) {
    return null;
  }

  const data = toolCall.rawOutput;
  const visibleToolCalls = data.toolCalls?.slice(-MAX_VISIBLE_TOOL_CALLS) ?? [];
  const hiddenToolCallCount = Math.max(
    0,
    (data.toolCalls?.length ?? 0) - visibleToolCalls.length,
  );

  return (
    <ToolCallCard icon="🤖">
      <ToolCallRow label="Agent">
        <div className="font-medium text-[var(--app-primary-foreground)]">
          {getHeaderTitle(data, toolCall.title)}
        </div>
      </ToolCallRow>

      <ToolCallRow label="Status">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{data.subagentName}</span>
          <span className="text-[var(--app-secondary-foreground)]">
            {STATUS_LABELS[data.status]}
          </span>
        </div>
      </ToolCallRow>

      {visibleToolCalls.length > 0 && (
        <ToolCallRow label={data.status === 'running' ? 'Progress' : 'Tools'}>
          <div className="flex flex-col gap-1">
            {visibleToolCalls.map((childToolCall) => (
              <div
                key={childToolCall.callId}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="font-mono text-[12px] text-[var(--app-primary-foreground)]">
                  {childToolCall.name}
                </span>
                <span className="text-[var(--app-secondary-foreground)]">
                  {CHILD_STATUS_LABELS[childToolCall.status]}
                </span>
                {childToolCall.description && (
                  <span className="text-[var(--app-secondary-foreground)]">
                    {childToolCall.description}
                  </span>
                )}
                {childToolCall.error && (
                  <span className="text-[#c74e39]">{childToolCall.error}</span>
                )}
              </div>
            ))}
            {hiddenToolCallCount > 0 && (
              <div className="text-[var(--app-secondary-foreground)]">
                +{hiddenToolCallCount} more tool calls
              </div>
            )}
          </div>
        </ToolCallRow>
      )}

      {data.executionSummary && (
        <ToolCallRow label="Summary">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>{data.executionSummary.totalToolCalls} tool calls</span>
            <span>
              {data.executionSummary.totalTokens.toLocaleString()} tokens
            </span>
            <span>{formatDuration(data.executionSummary.totalDurationMs)}</span>
          </div>
        </ToolCallRow>
      )}

      {(data.status === 'failed' || data.status === 'cancelled') &&
        data.terminateReason && (
          <ToolCallRow label="Reason">
            <div className="text-[#c74e39] font-medium">
              {data.terminateReason}
            </div>
          </ToolCallRow>
        )}
    </ToolCallCard>
  );
};
