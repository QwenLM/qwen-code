/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import type {
  AgentResultDisplay,
  AgentStatsSummary,
  Config,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { COLOR_OPTIONS } from '../constants.js';
import { fmtDuration } from '../utils.js';
import { ToolConfirmationMessage } from '../../messages/ToolConfirmationMessage.js';

export type DisplayMode = 'compact' | 'default' | 'verbose';

export interface AgentExecutionDisplayProps {
  data: AgentResultDisplay;
  availableHeight?: number;
  childWidth: number;
  config: Config;
  /** Whether this display's confirmation prompt should respond to keyboard input. */
  isFocused?: boolean;
  /** Whether another subagent's approval currently holds the focus lock, blocking this one. */
  isWaitingForOtherApproval?: boolean;
}

const getStatusColor = (
  status:
    | AgentResultDisplay['status']
    | 'executing'
    | 'success'
    | 'awaiting_approval',
) => {
  switch (status) {
    case 'running':
    case 'executing':
    case 'awaiting_approval':
      return theme.status.warning;
    case 'completed':
    case 'success':
      return theme.status.success;
    case 'cancelled':
      return theme.status.warning;
    case 'failed':
      return theme.status.error;
    default:
      return theme.text.secondary;
  }
};

const getStatusText = (status: AgentResultDisplay['status']) => {
  switch (status) {
    case 'running':
      return 'Running';
    case 'completed':
      return 'Completed';
    case 'cancelled':
      return 'User Cancelled';
    case 'failed':
      return 'Failed';
    default:
      return 'Unknown';
  }
};

const MAX_TOOL_CALLS = 5;
const MAX_TASK_PROMPT_LINES = 5;

// Fixed overhead lines in default/verbose mode:
// header(1) + "Task Detail:" label(1) + "Tools:" label(1) + gaps(3) + footer(1)
const EXPANDED_FIXED_OVERHEAD = 7;
// Minimum height to allow default mode (below this, auto-downgrade to compact)
const MIN_HEIGHT_FOR_DEFAULT = 5;
// Minimum height to allow verbose mode (below this, auto-downgrade to default)
const MIN_HEIGHT_FOR_VERBOSE = 15;
// Each tool call renders ~2 lines (name + result)
const LINES_PER_TOOL_CALL = 2;

/**
 * Computes how many task prompt lines and tool calls to render based on
 * available height. This prevents Ink from laying out content that far
 * exceeds the visible terminal area, which causes flickering.
 */
export function computeContentBudget(availableHeight: number | undefined): {
  maxTaskPromptLines: number;
  maxToolCalls: number;
} {
  if (
    availableHeight === undefined ||
    !Number.isFinite(availableHeight) ||
    availableHeight < 0
  ) {
    return {
      maxTaskPromptLines: MAX_TASK_PROMPT_LINES,
      maxToolCalls: MAX_TOOL_CALLS,
    };
  }

  const budget = Math.max(0, availableHeight - EXPANDED_FIXED_OVERHEAD);

  // Allocate minimum 2 lines for task prompt, rest for tool calls
  const minPromptLines = Math.min(2, budget);
  const remaining = budget - minPromptLines;

  // Cap tool calls before computing usedByTools so leftover is accurate
  const maxToolCalls = Math.min(
    Math.max(1, Math.floor(remaining / LINES_PER_TOOL_CALL)),
    MAX_TOOL_CALLS,
  );
  const usedByTools = maxToolCalls * LINES_PER_TOOL_CALL;

  // Give leftover lines back to task prompt
  const maxTaskPromptLines = Math.min(
    Math.max(1, minPromptLines + Math.max(0, remaining - usedByTools)),
    MAX_TASK_PROMPT_LINES,
  );

  return { maxTaskPromptLines, maxToolCalls };
}

/**
 * Component to display subagent execution progress and results.
 * This is now a pure component that renders the provided SubagentExecutionResultDisplay data.
 * Real-time updates are handled by the parent component updating the data prop.
 */
export const AgentExecutionDisplay: React.FC<AgentExecutionDisplayProps> = ({
  data,
  availableHeight,
  childWidth,
  config,
  isFocused = true,
  isWaitingForOtherApproval = false,
}) => {
  const [displayMode, setDisplayMode] = React.useState<DisplayMode>('compact');

  // Auto-downgrade display mode when available height is critically low.
  // This prevents expanding into a mode that causes severe flickering.
  const effectiveDisplayMode = useMemo(() => {
    if (
      availableHeight !== undefined &&
      availableHeight < MIN_HEIGHT_FOR_DEFAULT
    ) {
      return 'compact';
    }
    if (
      availableHeight !== undefined &&
      availableHeight < MIN_HEIGHT_FOR_VERBOSE &&
      displayMode === 'verbose'
    ) {
      return 'default';
    }
    return displayMode;
  }, [availableHeight, displayMode]);

  // Compute content budget based on available height to prevent Ink from
  // laying out content that far exceeds the visible terminal area.
  const { maxTaskPromptLines, maxToolCalls } = useMemo(
    () => computeContentBudget(availableHeight),
    [availableHeight],
  );

  const agentColor = useMemo(() => {
    const colorOption = COLOR_OPTIONS.find(
      (option) => option.name === data.subagentColor,
    );
    return colorOption?.value || theme.text.accent;
  }, [data.subagentColor]);

  const footerText = React.useMemo(() => {
    // This component only listens to keyboard shortcut events when the subagent is running
    if (data.status !== 'running') return '';

    if (effectiveDisplayMode === 'default') {
      const hasMoreLines =
        data.taskPrompt.split('\n').length > maxTaskPromptLines;
      const hasMoreToolCalls =
        data.toolCalls && data.toolCalls.length > maxToolCalls;

      if (hasMoreToolCalls || hasMoreLines) {
        return 'Press ctrl+e to show less, ctrl+f to show more.';
      }
      return 'Press ctrl+e to show less.';
    }

    if (effectiveDisplayMode === 'verbose') {
      return 'Press ctrl+f to show less.';
    }

    return '';
  }, [effectiveDisplayMode, data, maxTaskPromptLines, maxToolCalls]);

  // Handle keyboard shortcuts to control display mode.
  // Only active for running sub-agents without pending confirmations to:
  // 1. Prevent completed sub-agents from re-rendering on toggle (helps long sessions)
  // 2. Avoid keyboard conflicts with confirmation prompts
  useKeypress(
    (key) => {
      if (key.ctrl && key.name === 'e') {
        // ctrl+e toggles between compact and default
        setDisplayMode((current) =>
          current === 'compact' ? 'default' : 'compact',
        );
      } else if (key.ctrl && key.name === 'f') {
        // ctrl+f toggles between default and verbose
        setDisplayMode((current) =>
          current === 'default' ? 'verbose' : 'default',
        );
      }
    },
    { isActive: data.status === 'running' && !data.pendingConfirmation },
  );

  if (effectiveDisplayMode === 'compact') {
    return (
      <Box flexDirection="column">
        {/* Header: Agent name and status */}
        {!data.pendingConfirmation && (
          <Box flexDirection="row">
            <Text bold color={agentColor}>
              {data.subagentName}
            </Text>
            <StatusDot status={data.status} />
            <StatusIndicator status={data.status} />
          </Box>
        )}

        {/* Running state: Show current tool call and progress */}
        {data.status === 'running' && (
          <>
            {/* Current tool call */}
            {data.toolCalls && data.toolCalls.length > 0 && (
              <Box flexDirection="column">
                <ToolCallItem
                  toolCall={data.toolCalls[data.toolCalls.length - 1]}
                  compact={true}
                />
                {/* Show count of additional tool calls if there are more than 1 */}
                {data.toolCalls.length > 1 && !data.pendingConfirmation && (
                  <Box flexDirection="row" paddingLeft={4}>
                    <Text color={theme.text.secondary}>
                      +{data.toolCalls.length - 1} more tool calls (ctrl+e to
                      expand)
                    </Text>
                  </Box>
                )}
              </Box>
            )}

            {/* Inline approval prompt when awaiting confirmation */}
            {data.pendingConfirmation && (
              <Box flexDirection="column" marginTop={1} paddingLeft={1}>
                {isWaitingForOtherApproval && (
                  <Box marginBottom={0}>
                    <Text color={theme.text.secondary} dimColor>
                      ⏳ Waiting for other approval...
                    </Text>
                  </Box>
                )}
                <ToolConfirmationMessage
                  confirmationDetails={data.pendingConfirmation}
                  isFocused={isFocused}
                  availableTerminalHeight={availableHeight}
                  contentWidth={childWidth - 4}
                  compactMode={true}
                  config={config}
                />
              </Box>
            )}
          </>
        )}

        {/* Completed state: Show summary line */}
        {data.status === 'completed' && data.executionSummary && (
          <Box flexDirection="row" marginTop={1}>
            <Text color={theme.text.secondary}>
              Execution Summary: {data.executionSummary.totalToolCalls} tool
              uses · {data.executionSummary.totalTokens.toLocaleString()} tokens
              · {fmtDuration(data.executionSummary.totalDurationMs)}
            </Text>
          </Box>
        )}

        {/* Failed/Cancelled state: Show error reason */}
        {data.status === 'failed' && (
          <Box flexDirection="row" marginTop={1}>
            <Text color={theme.status.error}>
              Failed: {data.terminateReason}
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  // Default and verbose modes use normal layout
  return (
    <Box flexDirection="column" paddingX={1} gap={1}>
      {/* Header with subagent name and status */}
      <Box flexDirection="row">
        <Text bold color={agentColor}>
          {data.subagentName}
        </Text>
        <StatusDot status={data.status} />
        <StatusIndicator status={data.status} />
      </Box>

      {/* Task description */}
      <TaskPromptSection
        taskPrompt={data.taskPrompt}
        displayMode={effectiveDisplayMode}
        maxLines={maxTaskPromptLines}
      />

      {/* Progress section for running tasks */}
      {data.status === 'running' &&
        data.toolCalls &&
        data.toolCalls.length > 0 && (
          <Box flexDirection="column">
            <ToolCallsList
              toolCalls={data.toolCalls}
              displayMode={effectiveDisplayMode}
              maxCalls={maxToolCalls}
            />
          </Box>
        )}

      {/* Inline approval prompt when awaiting confirmation */}
      {data.pendingConfirmation && (
        <Box flexDirection="column">
          {isWaitingForOtherApproval && (
            <Box marginBottom={0}>
              <Text color={theme.text.secondary} dimColor>
                ⏳ Waiting for other approval...
              </Text>
            </Box>
          )}
          <ToolConfirmationMessage
            confirmationDetails={data.pendingConfirmation}
            config={config}
            isFocused={isFocused}
            availableTerminalHeight={availableHeight}
            contentWidth={childWidth - 4}
            compactMode={true}
          />
        </Box>
      )}

      {/* Results section for completed/failed tasks */}
      {(data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled') && (
        <ResultsSection
          data={data}
          displayMode={effectiveDisplayMode}
          maxCalls={maxToolCalls}
        />
      )}

      {/* Footer with keyboard shortcuts */}
      {footerText && (
        <Box flexDirection="row">
          <Text color={theme.text.secondary}>{footerText}</Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * Task prompt section with truncation support
 */
const TaskPromptSection: React.FC<{
  taskPrompt: string;
  displayMode: DisplayMode;
  maxLines: number;
}> = ({ taskPrompt, displayMode, maxLines }) => {
  const lines = taskPrompt.split('\n');
  const effectiveMax = displayMode === 'verbose' ? lines.length : maxLines;
  const shouldTruncate = lines.length > effectiveMax;
  const displayLines = lines.slice(0, effectiveMax);

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row">
        <Text color={theme.text.primary}>Task Detail: </Text>
        {shouldTruncate && displayMode === 'default' && (
          <Text color={theme.text.secondary}>
            {' '}
            Showing the first {effectiveMax} lines.
          </Text>
        )}
      </Box>
      <Box paddingLeft={1}>
        <Text wrap="wrap">
          {displayLines.join('\n') + (shouldTruncate ? '...' : '')}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Status dot component with similar height as text
 */
const StatusDot: React.FC<{
  status: AgentResultDisplay['status'];
}> = ({ status }) => (
  <Box marginLeft={1} marginRight={1}>
    <Text color={getStatusColor(status)}>●</Text>
  </Box>
);

/**
 * Status indicator component
 */
const StatusIndicator: React.FC<{
  status: AgentResultDisplay['status'];
}> = ({ status }) => {
  const color = getStatusColor(status);
  const text = getStatusText(status);
  return <Text color={color}>{text}</Text>;
};

/**
 * Tool calls list - format consistent with ToolInfo in ToolMessage.tsx
 */
const ToolCallsList: React.FC<{
  toolCalls: AgentResultDisplay['toolCalls'];
  displayMode: DisplayMode;
  maxCalls: number;
}> = ({ toolCalls, displayMode, maxCalls }) => {
  const calls = toolCalls || [];
  const effectiveMax = displayMode === 'verbose' ? calls.length : maxCalls;
  const shouldTruncate = calls.length > effectiveMax;
  const displayCalls = calls.slice(-effectiveMax);

  // Reverse the order to show most recent first
  const reversedDisplayCalls = [...displayCalls].reverse();

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme.text.primary}>Tools:</Text>
        {shouldTruncate && displayMode === 'default' && (
          <Text color={theme.text.secondary}>
            {' '}
            Showing the last {effectiveMax} of {calls.length} tools.
          </Text>
        )}
      </Box>
      {reversedDisplayCalls.map((toolCall, index) => (
        <ToolCallItem key={`${toolCall.name}-${index}`} toolCall={toolCall} />
      ))}
    </Box>
  );
};

/**
 * Individual tool call item - consistent with ToolInfo format
 */
const ToolCallItem: React.FC<{
  toolCall: {
    name: string;
    status: 'executing' | 'awaiting_approval' | 'success' | 'failed';
    error?: string;
    args?: Record<string, unknown>;
    result?: string;
    resultDisplay?: string;
    description?: string;
  };
  compact?: boolean;
}> = ({ toolCall, compact = false }) => {
  const STATUS_INDICATOR_WIDTH = 3;

  // Map subagent status to ToolCallStatus-like display
  const statusIcon = React.useMemo(() => {
    const color = getStatusColor(toolCall.status);
    switch (toolCall.status) {
      case 'executing':
        return <Text color={color}>⊷</Text>; // Using same as ToolMessage
      case 'awaiting_approval':
        return <Text color={theme.status.warning}>?</Text>;
      case 'success':
        return <Text color={color}>✓</Text>;
      case 'failed':
        return (
          <Text color={color} bold>
            x
          </Text>
        );
      default:
        return <Text color={color}>o</Text>;
    }
  }, [toolCall.status]);

  const description = React.useMemo(() => {
    if (!toolCall.description) return '';
    const firstLine = toolCall.description.split('\n')[0];
    return firstLine.length > 80
      ? firstLine.substring(0, 80) + '...'
      : firstLine;
  }, [toolCall.description]);

  // Get first line of resultDisplay for truncated output
  const truncatedOutput = React.useMemo(() => {
    if (!toolCall.resultDisplay) return '';
    const firstLine = toolCall.resultDisplay.split('\n')[0];
    return firstLine.length > 80
      ? firstLine.substring(0, 80) + '...'
      : firstLine;
  }, [toolCall.resultDisplay]);

  return (
    <Box flexDirection="column" paddingLeft={1} marginBottom={0}>
      {/* First line: status icon + tool name + description (consistent with ToolInfo) */}
      <Box flexDirection="row">
        <Box minWidth={STATUS_INDICATOR_WIDTH}>{statusIcon}</Box>
        <Text wrap="truncate-end">
          <Text>{toolCall.name}</Text>{' '}
          <Text color={theme.text.secondary}>{description}</Text>
          {toolCall.error && (
            <Text color={theme.status.error}> - {toolCall.error}</Text>
          )}
        </Text>
      </Box>

      {/* Second line: truncated returnDisplay output - hidden in compact mode */}
      {!compact && truncatedOutput && (
        <Box flexDirection="row" paddingLeft={STATUS_INDICATOR_WIDTH}>
          <Text color={theme.text.secondary}>{truncatedOutput}</Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * Execution summary details component
 */
const ExecutionSummaryDetails: React.FC<{
  data: AgentResultDisplay;
  displayMode: DisplayMode;
}> = ({ data, displayMode: _displayMode }) => {
  const stats = data.executionSummary;

  if (!stats) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color={theme.text.secondary}>• No summary available</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        • <Text>Duration: {fmtDuration(stats.totalDurationMs)}</Text>
      </Text>
      <Text>
        • <Text>Rounds: {stats.rounds}</Text>
      </Text>
      <Text>
        • <Text>Tokens: {stats.totalTokens.toLocaleString()}</Text>
      </Text>
    </Box>
  );
};

/**
 * Tool usage statistics component
 */
const ToolUsageStats: React.FC<{
  executionSummary?: AgentStatsSummary;
}> = ({ executionSummary }) => {
  if (!executionSummary) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color={theme.text.secondary}>• No tool usage data available</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Text>
        • <Text>Total Calls:</Text> {executionSummary.totalToolCalls}
      </Text>
      <Text>
        • <Text>Success Rate:</Text>{' '}
        <Text color={theme.status.success}>
          {executionSummary.successRate.toFixed(1)}%
        </Text>{' '}
        (
        <Text color={theme.status.success}>
          {executionSummary.successfulToolCalls} success
        </Text>
        ,{' '}
        <Text color={theme.status.error}>
          {executionSummary.failedToolCalls} failed
        </Text>
        )
      </Text>
    </Box>
  );
};

/**
 * Results section for completed executions - matches the clean layout from the image
 */
const ResultsSection: React.FC<{
  data: AgentResultDisplay;
  displayMode: DisplayMode;
  maxCalls: number;
}> = ({ data, displayMode, maxCalls }) => (
  <Box flexDirection="column" gap={1}>
    {/* Tool calls section - clean list format */}
    {data.toolCalls && data.toolCalls.length > 0 && (
      <ToolCallsList
        toolCalls={data.toolCalls}
        displayMode={displayMode}
        maxCalls={maxCalls}
      />
    )}

    {/* Execution Summary section - hide when cancelled */}
    {data.status === 'completed' && (
      <Box flexDirection="column">
        <Box flexDirection="row" marginBottom={1}>
          <Text color={theme.text.primary}>Execution Summary:</Text>
        </Box>
        <ExecutionSummaryDetails data={data} displayMode={displayMode} />
      </Box>
    )}

    {/* Tool Usage section - hide when cancelled */}
    {data.status === 'completed' && data.executionSummary && (
      <Box flexDirection="column">
        <Box flexDirection="row" marginBottom={1}>
          <Text color={theme.text.primary}>Tool Usage:</Text>
        </Box>
        <ToolUsageStats executionSummary={data.executionSummary} />
      </Box>
    )}

    {/* Error reason for failed tasks */}
    {data.status === 'cancelled' && (
      <Box flexDirection="row">
        <Text color={theme.status.warning}>⏹ User Cancelled</Text>
      </Box>
    )}
    {data.status === 'failed' && (
      <Box flexDirection="row">
        <Text color={theme.status.error}>Task Failed: </Text>
        <Text color={theme.status.error}>{data.terminateReason}</Text>
      </Box>
    )}
  </Box>
);
