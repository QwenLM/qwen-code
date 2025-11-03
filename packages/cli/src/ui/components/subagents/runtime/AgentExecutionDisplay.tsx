/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { Box, Text } from 'ink';
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
import { useUIActions } from '../../../contexts/UIActionsContext.js';
import { useUIState } from '../../../contexts/UIStateContext.js';
import type { SubagentFullscreenPanelState } from '../../../types.js';
import { CTRL_ALT_E_SEQUENCE } from './fullscreenKeys.js';
import { getStatusColor, getStatusText } from './status.js';

export type DisplayMode = 'compact' | 'default' | 'verbose';

export interface AgentExecutionDisplayProps {
  data: TaskResultDisplay;
  availableHeight?: number;
  childWidth: number;
  config: Config;
}

const MAX_TOOL_CALLS = 5;
const MAX_TASK_PROMPT_LINES = 5;
const MAX_FULLSCREEN_RESULT_LINES = 12;

const TOOL_CALL_STATUS_ICONS = {
  executing: '⊷',
  awaiting_approval: '?',
  success: '✓',
  failed: '✖',
} as const;

const TOOL_CALL_STATUS_TEXT = {
  executing: 'Executing',
  awaiting_approval: 'Awaiting approval',
  success: 'Success',
  failed: 'Failed',
} as const;

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
  const uiActions = useUIActions();
  const uiState = useUIState();
  const panelIdRef = React.useRef<string>(
    `subagent-${Math.random().toString(36).slice(2)}`,
  );
  const panelId = panelIdRef.current;
  const panelOpen = uiState.subagentFullscreenPanel?.panelId === panelId;
  const renderDataRef = React.useRef<TaskResultDisplay>(data);
  renderDataRef.current = data;

  const [displayMode, setDisplayMode] = React.useState<DisplayMode>('compact');

  const agentColor = useMemo(() => {
    const colorOption = COLOR_OPTIONS.find(
      (option) => option.name === data.subagentColor,
    );
    return colorOption?.value || theme.text.accent;
  }, [data.subagentColor]);

  const fullscreenHint = ' Press ctrl+alt+e for fullscreen.';
  const fullscreenContent = React.useMemo(
    () => buildFullscreenContent(data),
    [data],
  );

  const footerText = React.useMemo(() => {
    // This component only listens to keyboard shortcut events when the subagent is running
    if (data.status !== 'running') return '';

    if (displayMode === 'default') {
      const hasMoreLines =
        data.taskPrompt.split('\n').length > MAX_TASK_PROMPT_LINES;
      const hasMoreToolCalls =
        data.toolCalls && data.toolCalls.length > MAX_TOOL_CALLS;

      if (hasMoreToolCalls || hasMoreLines) {
        return `Press ctrl+r to show less, ctrl+e to show more.${fullscreenHint}`;
      }
      return `Press ctrl+r to show less.${fullscreenHint}`;
    }

    if (displayMode === 'verbose') {
      return `Press ctrl+e to show less.${fullscreenHint}`;
    }

    if (displayMode === 'compact') {
      return `Press ctrl+r to expand.${fullscreenHint}`;
    }

    return fullscreenHint.trim();
  }, [displayMode, data]);

  const openFullscreen = React.useCallback(() => {
    const panel: SubagentFullscreenPanelState = {
      panelId,
      subagentName: data.subagentName,
      status: data.status,
      content: fullscreenContent,
      getSnapshot: () => buildFullscreenContent(renderDataRef.current),
    };
    uiActions.openSubagentFullscreenPanel(panel);
  }, [data, fullscreenContent, panelId, uiActions]);

  const closeFullscreen = React.useCallback(() => {
    uiActions.closeSubagentFullscreenPanel(panelId);
  }, [panelId, uiActions]);

  // Handle keyboard shortcuts to control display mode and fullscreen toggle
  useKeypress(
    (key) => {
      const sequence = key.sequence ?? '';
      const isCtrlAltToggle =
        (key.ctrl && key.meta && key.name === 'e') ||
        sequence === CTRL_ALT_E_SEQUENCE;

      if (isCtrlAltToggle) {
        if (panelOpen) {
          closeFullscreen();
        } else {
          openFullscreen();
        }
        return;
      }

      if (panelOpen) {
        return;
      }

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

  React.useEffect(() => {
    if (!panelOpen) {
      return;
    }
    uiActions.updateSubagentFullscreenPanel(panelId, {
      content: fullscreenContent,
      status: data.status,
      subagentName: data.subagentName,
    });
  }, [
    panelOpen,
    data.status,
    data.subagentName,
    fullscreenContent,
    panelId,
    uiActions,
  ]);

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
                    <Text color={theme.text.secondary}>
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

        <Box flexDirection="row" marginTop={1}>
          <Text color={theme.text.secondary}>
            Press ctrl+alt+e for fullscreen.
          </Text>
        </Box>
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
        showFullscreenHint={true}
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
  showFullscreenHint?: boolean;
}> = ({ taskPrompt, displayMode, showFullscreenHint = false }) => {
  const lines = taskPrompt.split('\n');
  const shouldTruncate = lines.length > 10;
  const showFull = displayMode === 'verbose';
  const displayLines = showFull ? lines : lines.slice(0, MAX_TASK_PROMPT_LINES);

  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row">
        <Text color={theme.text.primary}>Task Detail: </Text>
        {shouldTruncate && displayMode === 'default' && (
          <Text color={theme.text.secondary}>
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
      {showFullscreenHint && (
        <Box paddingLeft={1}>
          <Text color={theme.text.secondary}>
            Press ctrl+alt+e for fullscreen.
          </Text>
        </Box>
      )}
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
          <Text color={theme.text.secondary}>
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
  data: TaskResultDisplay;
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
  executionSummary?: SubagentStatsSummary;
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

function appendMultiline(
  lines: string[],
  text: string,
  indent: string,
  maxLines?: number,
) {
  if (!text) {
    return;
  }

  const rawLines = text.split('\n');
  const limitedLines =
    maxLines !== undefined ? rawLines.slice(0, maxLines) : rawLines;

  for (const rawLine of limitedLines) {
    lines.push(`${indent}${rawLine}`);
  }

  if (maxLines !== undefined && rawLines.length > maxLines) {
    lines.push(`${indent}…`);
  }
}

function trimTrailingBlankLines(lines: string[]) {
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
}

function buildFullscreenContent(data: TaskResultDisplay): string[] {
  const lines: string[] = [];

  lines.push(`Agent: ${data.subagentName}`);
  lines.push(`Status: ${getStatusText(data.status)}`);
  if (data.taskDescription) {
    lines.push(`Description: ${data.taskDescription}`);
  }
  lines.push('');

  lines.push('Task Prompt:');
  if (data.taskPrompt.trim().length === 0) {
    lines.push('  <empty>');
  } else {
    appendMultiline(lines, data.taskPrompt, '  ');
  }
  lines.push('');

  if (data.pendingConfirmation) {
    lines.push('Pending Confirmation:');
    lines.push(`  ${data.pendingConfirmation.title}`);
    if (
      'command' in data.pendingConfirmation &&
      data.pendingConfirmation.command
    ) {
      lines.push(`  Command: ${data.pendingConfirmation.command}`);
    }
    if (
      'toolName' in data.pendingConfirmation &&
      data.pendingConfirmation.toolName
    ) {
      lines.push(`  Tool: ${data.pendingConfirmation.toolName}`);
    }
    if ('plan' in data.pendingConfirmation && data.pendingConfirmation.plan) {
      appendMultiline(lines, data.pendingConfirmation.plan, '  ');
    }
    if (
      'prompt' in data.pendingConfirmation &&
      data.pendingConfirmation.prompt
    ) {
      appendMultiline(lines, data.pendingConfirmation.prompt, '  ');
    }
    lines.push('');
  }

  if (data.toolCalls && data.toolCalls.length > 0) {
    lines.push('Tool Calls:');
    data.toolCalls.forEach((toolCall, index) => {
      const icon = TOOL_CALL_STATUS_ICONS[toolCall.status];
      const statusText = TOOL_CALL_STATUS_TEXT[toolCall.status];
      lines.push(`  ${index + 1}. ${icon} ${toolCall.name} — ${statusText}`);
      if (toolCall.description) {
        appendMultiline(lines, toolCall.description, '     ');
      }
      if (toolCall.error) {
        lines.push(`     Error: ${toolCall.error}`);
      }
      if (toolCall.resultDisplay) {
        lines.push('     Result:');
        appendMultiline(
          lines,
          toolCall.resultDisplay,
          '       ',
          MAX_FULLSCREEN_RESULT_LINES,
        );
      } else if (toolCall.result) {
        lines.push('     Result:');
        appendMultiline(
          lines,
          toolCall.result,
          '       ',
          MAX_FULLSCREEN_RESULT_LINES,
        );
      }
    });
    lines.push('');
  }

  if (data.status === 'failed' && data.terminateReason) {
    lines.push(`Failure reason: ${data.terminateReason}`);
    lines.push('');
  }

  if (data.status === 'cancelled' && data.terminateReason) {
    lines.push(`Cancelled: ${data.terminateReason}`);
    lines.push('');
  }

  if (data.status === 'completed' && data.executionSummary) {
    const summary = data.executionSummary;
    lines.push('Execution Summary:');
    lines.push(
      `  Duration: ${fmtDuration(summary.totalDurationMs)} · Rounds: ${summary.rounds}`,
    );
    lines.push(
      `  Tool Calls: ${summary.totalToolCalls} (${summary.successfulToolCalls} success, ${summary.failedToolCalls} failed)`,
    );
    lines.push(`  Success Rate: ${summary.successRate.toFixed(1)}%`);
    lines.push(
      `  Tokens: ${summary.totalTokens.toLocaleString()} (in ${summary.inputTokens.toLocaleString()}, out ${summary.outputTokens.toLocaleString()})`,
    );
    if (summary.estimatedCost) {
      lines.push(`  Estimated Cost: $${summary.estimatedCost.toFixed(4)}`);
    }
    lines.push('');
  }

  if (data.result) {
    lines.push('Result:');
    appendMultiline(lines, data.result, '  ', MAX_FULLSCREEN_RESULT_LINES);
    lines.push('');
  }

  trimTrailingBlankLines(lines);
  return lines;
}
