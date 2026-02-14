/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * TaskToolCall component - displays subagent/task tool execution
 * Supports both runtime (expandable) and replay (summary) modes
 */

import { useState, type FC } from 'react';
import {
  ToolCallContainer,
  ToolCallCard,
  ToolCallRow,
  mapToolStatusToContainerStatus,
} from './shared/index.js';
import type { BaseToolCallProps } from './shared/index.js';

/**
 * Subagent execution summary stats (from SubagentStatsSummary)
 */
interface ExecutionSummary {
  rounds?: number;
  totalDurationMs?: number;
  totalToolCalls?: number;
  successfulToolCalls?: number;
  failedToolCalls?: number;
  successRate?: number;
  inputTokens?: number;
  outputTokens?: number;
  thoughtTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  estimatedCost?: number;
}

/**
 * Internal tool call info within a task execution
 */
interface TaskToolCallInfo {
  callId: string;
  name: string;
  status: 'executing' | 'awaiting_approval' | 'success' | 'failed';
  error?: string;
  args?: Record<string, unknown>;
  result?: string;
  description?: string;
}

/**
 * Task execution result display structure
 */
interface TaskResultDisplay {
  type: 'task_execution';
  subagentName: string;
  subagentColor?: string;
  taskDescription: string;
  taskPrompt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  terminateReason?: string;
  result?: string;
  executionSummary?: ExecutionSummary;
  toolCalls?: TaskToolCallInfo[];
}

/**
 * Props for TaskToolCall component
 * Automatically detects runtime vs replay mode based on data availability
 */
export interface TaskToolCallProps extends BaseToolCallProps {
  /** @deprecated Runtime mode is now auto-detected based on nested tool calls data */
  isRuntime?: boolean;
}

/**
 * Parse TaskResultDisplay from rawOutput
 */
function parseTaskResultDisplay(rawOutput: unknown): TaskResultDisplay | null {
  if (!rawOutput || typeof rawOutput !== 'object') return null;

  const obj = rawOutput as Record<string, unknown>;
  if (obj.type !== 'task_execution') return null;

  // Type guard check for required fields
  if (
    typeof obj.subagentName !== 'string' ||
    typeof obj.taskDescription !== 'string' ||
    typeof obj.taskPrompt !== 'string' ||
    !['running', 'completed', 'failed', 'cancelled'].includes(
      obj.status as string,
    )
  ) {
    return null;
  }

  return obj as unknown as TaskResultDisplay;
}

/**
 * Parse rawInput to get task parameters
 */
function parseTaskParams(rawInput: unknown): {
  description?: string;
  prompt?: string;
  subagent_type?: string;
} {
  if (!rawInput || typeof rawInput !== 'object') return {};
  return rawInput as Record<string, unknown>;
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format token count
 */
function formatTokens(count: number | undefined): string {
  if (count === undefined || count === null) return '-';
  return count.toLocaleString();
}

/**
 * Map task execution status to tool call status
 */
function mapTaskStatusToToolStatus(
  status: TaskResultDisplay['status'],
): 'pending' | 'in_progress' | 'completed' | 'failed' {
  switch (status) {
    case 'running':
      return 'in_progress';
    case 'completed':
      return 'completed';
    case 'failed':
    case 'cancelled':
      return 'failed';
    default:
      return 'in_progress';
  }
}

/**
 * Individual tool call item in the nested list
 */
const NestedToolCallItem: FC<{ toolCall: TaskToolCallInfo }> = ({
  toolCall,
}) => {
  const statusText =
    toolCall.status === 'awaiting_approval'
      ? 'awaiting approval'
      : toolCall.status;

  return (
    <div className="flex items-center gap-2 py-1 text-sm border-b border-[var(--app-input-border)] last:border-0">
      <span
        className={`w-2 h-2 rounded-full ${
          toolCall.status === 'success'
            ? 'bg-green-500'
            : toolCall.status === 'failed'
              ? 'bg-red-500'
              : toolCall.status === 'awaiting_approval'
                ? 'bg-yellow-500'
                : 'bg-blue-500'
        }`}
      />
      <span className="font-medium text-[var(--app-primary-foreground)]">
        {toolCall.name}
      </span>
      <span className="text-xs text-[var(--app-secondary-foreground)]">
        {toolCall.description || ''}
      </span>
      <span className="text-xs text-[var(--app-secondary-foreground)] ml-auto capitalize">
        {statusText}
      </span>
    </div>
  );
};

/**
 * TaskToolCall component - displays subagent execution with:
 * - Runtime mode: expandable to show detailed progress and nested tool calls
 * - Replay mode: summary view with execution stats (no nested details)
 *
 * Mode is auto-detected: if nested toolCalls array has items, it's runtime mode.
 */
export const TaskToolCall: FC<TaskToolCallProps> = ({
  toolCall,
  isFirst,
  isLast,
  isRuntime: _isRuntime,
}) => {
  const { title, rawInput, rawOutput, status: toolStatus } = toolCall;
  const [isExpanded, setIsExpanded] = useState(false);

  // Parse task parameters from rawInput
  const taskParams = parseTaskParams(rawInput);
  const taskDescription =
    taskParams.description || (typeof title === 'string' ? title : '');

  // Parse TaskResultDisplay from rawOutput
  const resultDisplay = parseTaskResultDisplay(rawOutput);

  // Determine display mode and data source
  const hasDetailedResult = resultDisplay !== null;
  const subagentName =
    resultDisplay?.subagentName || taskParams.subagent_type || 'Subagent';
  const executionStatus = resultDisplay?.status || 'running';
  const summary = resultDisplay?.executionSummary;
  const nestedToolCalls = resultDisplay?.toolCalls || [];

  // Auto-detect runtime mode: if we have nested tool calls data, it's runtime
  const isRuntimeMode = nestedToolCalls.length > 0;

  // Determine if expandable (only in runtime mode with data)
  const canExpand = isRuntimeMode;

  // Get appropriate status
  const displayStatus = hasDetailedResult
    ? mapTaskStatusToToolStatus(executionStatus)
    : toolStatus;

  const containerStatus = mapToolStatusToContainerStatus(displayStatus);

  // Compact view for replay mode or collapsed runtime
  if (!isExpanded) {
    return (
      <ToolCallContainer
        label="Task"
        status={containerStatus}
        toolCallId={toolCall.toolCallId}
        isFirst={isFirst}
        isLast={isLast}
        labelSuffix={
          <span className="flex items-center gap-2">
            <span className="text-[var(--app-secondary-foreground)]">
              {subagentName}
            </span>
            {canExpand && (
              <button
                onClick={() => setIsExpanded(true)}
                className="text-xs text-[var(--app-link-color)] hover:underline cursor-pointer"
                type="button"
              >
                Show details
              </button>
            )}
          </span>
        }
      >
        <div className="flex flex-col gap-1">
          <span className="text-[var(--app-primary-foreground)]">
            {taskDescription}
          </span>

          {/* Execution stats - shown in both modes when available */}
          {summary && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--app-secondary-foreground)] mt-1">
              {typeof summary.rounds === 'number' && (
                <span>{summary.rounds} rounds</span>
              )}
              {typeof summary.totalDurationMs === 'number' && (
                <span>{formatDuration(summary.totalDurationMs)}</span>
              )}
              {typeof summary.totalTokens === 'number' && (
                <span>
                  {formatTokens(summary.totalTokens)} tokens
                  {(summary.inputTokens || summary.outputTokens) && (
                    <span className="opacity-70">
                      {' '}
                      (in {formatTokens(summary.inputTokens)}, out{' '}
                      {formatTokens(summary.outputTokens)})
                    </span>
                  )}
                </span>
              )}
              {typeof summary.totalToolCalls === 'number' &&
                summary.totalToolCalls > 0 && (
                  <span>
                    {summary.totalToolCalls} tool calls
                    {typeof summary.successRate === 'number' && (
                      <span className="opacity-70">
                        {' '}
                        ({summary.successRate.toFixed(0)}% success)
                      </span>
                    )}
                  </span>
                )}
            </div>
          )}

          {/* Show terminate reason for failed/cancelled tasks */}
          {resultDisplay?.terminateReason &&
            executionStatus !== 'completed' && (
              <span className="text-sm text-[#c74e39] mt-1">
                {resultDisplay.terminateReason}
              </span>
            )}

          {/* Result preview (truncated) - only show in replay mode */}
          {resultDisplay?.result && !isRuntimeMode && (
            <div className="text-sm text-[var(--app-secondary-foreground)] mt-1 line-clamp-2">
              {resultDisplay.result}
            </div>
          )}
        </div>
      </ToolCallContainer>
    );
  }

  // Expanded view (runtime mode only)
  return (
    <ToolCallCard icon="">
      {/* Header with basic info */}
      <ToolCallRow label="Task">
        <div className="flex items-center gap-2">
          <span className="font-medium">{subagentName}</span>
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              displayStatus === 'completed'
                ? 'bg-green-500'
                : displayStatus === 'failed'
                  ? 'bg-red-500'
                  : displayStatus === 'in_progress'
                    ? 'bg-blue-500'
                    : 'bg-gray-500'
            }`}
          />
          <span className="text-xs text-[var(--app-secondary-foreground)] capitalize">
            {displayStatus === 'in_progress' ? 'Running' : displayStatus}
          </span>
          {canExpand && (
            <button
              onClick={() => setIsExpanded(false)}
              className="text-xs text-[var(--app-link-color)] hover:underline cursor-pointer ml-auto"
              type="button"
            >
              Hide details
            </button>
          )}
        </div>
      </ToolCallRow>

      {/* Description */}
      <ToolCallRow label="Description">
        <span>{taskDescription}</span>
      </ToolCallRow>

      {/* Execution Summary Stats */}
      {summary && (
        <ToolCallRow label="Stats">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            {typeof summary.rounds === 'number' && (
              <span>Rounds: {summary.rounds}</span>
            )}
            {typeof summary.totalDurationMs === 'number' && (
              <span>Duration: {formatDuration(summary.totalDurationMs)}</span>
            )}
            {typeof summary.totalTokens === 'number' && (
              <span className="col-span-2">
                Tokens: {formatTokens(summary.totalTokens)} total
                {(summary.inputTokens || summary.outputTokens) && (
                  <span className="opacity-70">
                    {' '}
                    (in: {formatTokens(summary.inputTokens)}, out:{' '}
                    {formatTokens(summary.outputTokens)}
                    {summary.thoughtTokens
                      ? `, thoughts: ${formatTokens(summary.thoughtTokens)}`
                      : ''}
                    )
                  </span>
                )}
              </span>
            )}
            {typeof summary.totalToolCalls === 'number' && (
              <span className="col-span-2">
                Tool Calls: {summary.totalToolCalls} total
                {typeof summary.successfulToolCalls === 'number' && (
                  <span className="text-green-600">
                    {' '}
                    ({summary.successfulToolCalls} success
                  </span>
                )}
                {typeof summary.failedToolCalls === 'number' &&
                  summary.failedToolCalls > 0 && (
                    <span className="text-red-600">
                      {' '}
                      {summary.failedToolCalls} failed
                    </span>
                  )}
                {typeof summary.successfulToolCalls === 'number' && ')'}
                {typeof summary.successRate === 'number' && (
                  <span className="opacity-70">
                    {' '}
                    - {summary.successRate.toFixed(1)}% success rate
                  </span>
                )}
              </span>
            )}
            {typeof summary.estimatedCost === 'number' && (
              <span className="col-span-2 text-xs opacity-70">
                Estimated cost: ${summary.estimatedCost.toFixed(4)}
              </span>
            )}
          </div>
        </ToolCallRow>
      )}

      {/* Nested Tool Calls List */}
      {nestedToolCalls.length > 0 && (
        <ToolCallRow label="Tools">
          <div className="border border-[var(--app-input-border)] rounded p-2 max-h-[200px] overflow-y-auto">
            {nestedToolCalls.map((tc) => (
              <NestedToolCallItem key={tc.callId} toolCall={tc} />
            ))}
          </div>
        </ToolCallRow>
      )}

      {/* Task Result Output */}
      {resultDisplay?.result && (
        <ToolCallRow label="Result">
          <div className="bg-[var(--app-primary-background)] border border-[var(--app-input-border)] rounded p-2 max-h-[150px] overflow-y-auto text-sm whitespace-pre-wrap">
            {resultDisplay.result}
          </div>
        </ToolCallRow>
      )}

      {/* Error/Terminate Reason */}
      {resultDisplay?.terminateReason && executionStatus !== 'completed' && (
        <ToolCallRow label="Status">
          <span className="text-[#c74e39]">
            {resultDisplay.terminateReason}
          </span>
        </ToolCallRow>
      )}
    </ToolCallCard>
  );
};

export default TaskToolCall;
