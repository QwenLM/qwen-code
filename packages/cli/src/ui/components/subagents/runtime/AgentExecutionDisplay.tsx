/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
import { Colors } from '../../../colors.js';
import type {
  TaskResultDisplay,
  SubagentStatsSummary,
  Config,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { COLOR_OPTIONS } from '../constants.js';
import { fmtDuration } from '../utils.js';
import { ToolConfirmationMessage } from '../../messages/ToolConfirmationMessage.js';

export type DisplayMode = 'compact' | 'default' | 'verbose';

export interface AgentExecutionDisplayProps {
  data: TaskResultDisplay;
  availableHeight?: number;
  childWidth: number;
  config: Config;
}

const getStatusColor = (
  status:
    | TaskResultDisplay['status']
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
      return Colors.Gray;
  }
};

const getStatusText = (status: TaskResultDisplay['status']) => {
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
}) => {
  const [displayMode, setDisplayMode] = React.useState<DisplayMode>('compact');

  const agentColor = useMemo(() => {
    const colorOption = COLOR_OPTIONS.find(
      (option) => option.name === data.subagentColor,
    );
    return colorOption?.value || theme.text.accent;
  }, [data.subagentColor]);

  const footerText = React.useMemo(() => {
    // This component only listens to keyboard shortcut events when the subagent is running
    if (data.status !== 'running') return '';

    if (displayMode === 'default') {
      const hasMoreLines =
        data.taskPrompt.split('\n').length > MAX_TASK_PROMPT_LINES;
      const hasMoreToolCalls =
        data.toolCalls && data.toolCalls.length > MAX_TOOL_CALLS;

      if (hasMoreToolCalls || hasMoreLines) {
        return 'Press ctrl+r to show less, ctrl+e to show more.';
      }
      return 'Press ctrl+r to show less.';
    }

    if (displayMode === 'verbose') {
      return 'Press ctrl+e to show less.';
    }

    return '';
  }, [displayMode, data]);

  // Handle keyboard shortcuts to control display mode
  useKeypress(
    (key) => {
      if (key.ctrl && key.name === 'r') {
        // ctrl+r toggles between compact and default
        setDisplayMode((current) =>
          current === 'compact' ? 'default' : 'compact',
        );
      } else if (key.ctrl && key.name === 'e') {
        // ctrl+e toggles between default and verbose
        setDisplayMode((current) =>
          current === 'default' ? 'verbose' : 'default',
        );
      }
    },
    { isActive: true },
  );

  if (displayMode === 'compact') {
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
                    <Text color={Colors.Gray}>
                      +{data.toolCalls.length - 1} more tool calls (ctrl+r to
                      expand)
                    </Text>
                  </Box>
                )}
              </Box>
            )}

            {/* Inline approval prompt when awaiting confirmation */}
            {data.pendingConfirmation && (
              <Box flexDirection="column" marginTop={1} paddingLeft={1}>
                <ToolConfirmationMessage
                  confirmationDetails={data.pendingConfirmation}
                  isFocused={true}
                  availableTerminalHeight={availableHeight}
                  terminalWidth={childWidth}
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
        displayMode={displayMode}
      />

      {/* Progress section for running tasks */}
      {data.status === 'running' &&
        data.toolCalls &&
        data.toolCalls.length > 0 && (
          <Box flexDirection="column">
            <ToolCallsList
              toolCalls={data.toolCalls}
              displayMode={displayMode}
            />
          </Box>
        )}

      {/* Inline approval prompt when awaiting confirmation */}
      {data.pendingConfirmation && (
        <Box flexDirection="column">
          <ToolConfirmationMessage
            confirmationDetails={data.pendingConfirmation}
            config={config}
            isFocused={true}
            availableTerminalHeight={availableHeight}
            terminalWidth={childWidth}
            compactMode={true}
          />
        </Box>
      )}

      {/* Results section for completed/failed tasks */}
      {(data.status === 'completed' ||
        data.status === 'failed' ||
        data.status === 'cancelled') && (
        <ResultsSection data={data} displayMode={displayMode} />
      )}

      {/* Footer with keyboard shortcuts */}
      {footerText && (
        <Box flexDirection="row">
          <Text color={Colors.Gray}>{footerText}</Text>
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
}> = ({ taskPrompt, displayMode }) => {
  const lines = taskPrompt.split('\n');
  const shouldTruncate = lines.length > 10;
  const showFull = displayMode === 'verbose';
  const displayLines = showFull ? lines : lines.slice(0, MAX_TASK_PROMPT_LINES);

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row">
        <Text color={theme.text.primary}>Task Detail: </Text>
        {shouldTruncate && displayMode === 'default' && (
          <Text color={Colors.Gray}>
            {' '}
            Showing the first {MAX_TASK_PROMPT_LINES} lines.
          </Text>
        )}
      </Box>
      <Box paddingLeft={1}>
        <Text wrap="wrap">
          {displayLines.join('\n') + (shouldTruncate && !showFull ? '...' : '')}
        </Text>
      </Box>
    </Box>
  );
};

/**
 * Status dot component with similar height as text
 */
const StatusDot: React.FC<{
  status: TaskResultDisplay['status'];
}> = ({ status }) => (
  <Box marginLeft={1} marginRight={1}>
    <Text color={getStatusColor(status)}>●</Text>
  </Box>
);

/**
 * Status indicator component
 */
const StatusIndicator: React.FC<{
  status: TaskResultDisplay['status'];
}> = ({ status }) => {
  const color = getStatusColor(status);
  const text = getStatusText(status);
  return <Text color={color}>{text}</Text>;
};

/**
 * Tool calls list - format consistent with ToolInfo in ToolMessage.tsx
 */
const ToolCallsList: React.FC<{
  toolCalls: TaskResultDisplay['toolCalls'];
  displayMode: DisplayMode;
}> = ({ toolCalls, displayMode }) => {
  const calls = toolCalls || [];
  const shouldTruncate = calls.length > MAX_TOOL_CALLS;
  const showAll = displayMode === 'verbose';
  const displayCalls = showAll ? calls : calls.slice(-MAX_TOOL_CALLS); // Show last 5

  // Reverse the order to show most recent first
  const reversedDisplayCalls = [...displayCalls].reverse();

  return (
    <Box flexDirection="column">
      <Box flexDirection="row" marginBottom={1}>
        <Text color={theme.text.primary}>Tools:</Text>
        {shouldTruncate && displayMode === 'default' && (
          <Text color={Colors.Gray}>
            {' '}
            Showing the last {MAX_TOOL_CALLS} of {calls.length} tools.
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
          <Text color={Colors.Gray}>{description}</Text>
          {toolCall.error && (
            <Text color={theme.status.error}> - {toolCall.error}</Text>
          )}
        </Text>
      </Box>

      {/* Second line: truncated returnDisplay output - hidden in compact mode */}
      {!compact && truncatedOutput && (
        <Box flexDirection="row" paddingLeft={STATUS_INDICATOR_WIDTH}>
          <Text color={Colors.Gray}>{truncatedOutput}</Text>
        </Box>
      )}
    </Box>
  );
};

/**
 * Execution summary details component
 */
const ExecutionSummaryDetails: React.FC<{
  data: TaskResultDisplay;
  displayMode: DisplayMode;
}> = ({ data, displayMode: _displayMode }) => {
  const stats = data.executionSummary;

  if (!stats) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color={Colors.Gray}>• No summary available</Text>
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
  executionSummary?: SubagentStatsSummary;
}> = ({ executionSummary }) => {
  if (!executionSummary) {
    return (
      <Box flexDirection="column" paddingLeft={1}>
        <Text color={Colors.Gray}>• No tool usage data available</Text>
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
        <Text color={Colors.AccentGreen}>
          {executionSummary.successRate.toFixed(1)}%
        </Text>{' '}
        (
        <Text color={Colors.AccentGreen}>
          {executionSummary.successfulToolCalls} success
        </Text>
        ,{' '}
        <Text color={Colors.AccentRed}>
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
  data: TaskResultDisplay;
  displayMode: DisplayMode;
}> = ({ data, displayMode }) => (
  <Box flexDirection="column" gap={1}>
    {/* Tool calls section - clean list format */}
    {data.toolCalls && data.toolCalls.length > 0 && (
      <ToolCallsList toolCalls={data.toolCalls} displayMode={displayMode} />
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
