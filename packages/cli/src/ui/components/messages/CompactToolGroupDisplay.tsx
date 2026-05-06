/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import type { AnsiOutputDisplay } from '@qwen-code/qwen-code-core';
import { SHELL_COMMAND_NAME, SHELL_NAME } from '../../constants.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import { ToolStatusIndicator } from '../shared/ToolStatusIndicator.js';
import { ToolElapsedTime } from '../shared/ToolElapsedTime.js';

interface CompactToolGroupDisplayProps {
  toolCalls: IndividualToolCallDisplay[];
  contentWidth: number;
  /**
   * Optional LLM-generated label (~30 chars, git-commit-subject style) that
   * replaces the "active tool name + count + description" header when
   * present. Falls back to the default rendering while the label is still
   * being generated or if generation was skipped/failed.
   */
  compactLabel?: string;
}

// Priority: Confirming > Executing > Error > Canceled > Pending > Success
function getOverallStatus(
  toolCalls: IndividualToolCallDisplay[],
): ToolCallStatus {
  if (toolCalls.some((t) => t.status === ToolCallStatus.Confirming))
    return ToolCallStatus.Confirming;
  if (toolCalls.some((t) => t.status === ToolCallStatus.Executing))
    return ToolCallStatus.Executing;
  if (toolCalls.some((t) => t.status === ToolCallStatus.Error))
    return ToolCallStatus.Error;
  if (toolCalls.some((t) => t.status === ToolCallStatus.Canceled))
    return ToolCallStatus.Canceled;
  if (toolCalls.some((t) => t.status === ToolCallStatus.Pending))
    return ToolCallStatus.Pending;
  return ToolCallStatus.Success;
}

// Active tool priority: Confirming > Executing > last in array
function getActiveTool(
  toolCalls: IndividualToolCallDisplay[],
): IndividualToolCallDisplay {
  return (
    toolCalls.find((t) => t.status === ToolCallStatus.Confirming) ??
    toolCalls.find((t) => t.status === ToolCallStatus.Executing) ??
    toolCalls[toolCalls.length - 1]
  );
}

// Pull the configured shell timeout off an AnsiOutputDisplay result so
// ToolElapsedTime can surface it inline (matches the expanded
// ToolMessage path). Non-ansi resultDisplay → undefined → legacy
// quiet-then-elapsed behavior.
function getShellTimeoutMs(
  tool: IndividualToolCallDisplay,
): number | undefined {
  const display = tool.resultDisplay;
  if (
    typeof display === 'object' &&
    display !== null &&
    'ansiOutput' in display
  ) {
    return (display as AnsiOutputDisplay).timeoutMs;
  }
  return undefined;
}

/**
 * Summary-label header: bold label + " · N tools" count when there are 2+
 * tools in the batch. The count is intentionally suppressed for N=1 so
 * single-tool batches don't read as `Read config.json · 1 tools`. Future
 * edits: keep the `length > 1` guard, not `>= 1`.
 */
function renderSummaryHeader(label: string, count: number) {
  return (
    <>
      <Text bold>{label}</Text>
      {count > 1 ? (
        <Text color={theme.text.secondary}>
          {'  · '}
          {count} tools
        </Text>
      ) : null}
    </>
  );
}

/**
 * Default header: active tool name + " × N" count + first-line description.
 * Same N=1 suffix suppression as `renderSummaryHeader`.
 */
function renderDefaultHeader(
  activeToolName: string,
  activeToolDescription: string,
  count: number,
) {
  return (
    <>
      <Text bold>{activeToolName}</Text>
      {count > 1 ? (
        <Text color={theme.text.secondary}>
          {' × '}
          {count}
        </Text>
      ) : null}
      {activeToolDescription ? (
        <Text color={theme.text.secondary}>
          {'  '}
          {activeToolDescription}
        </Text>
      ) : null}
    </>
  );
}

export const CompactToolGroupDisplay: React.FC<
  CompactToolGroupDisplayProps
> = ({ toolCalls, contentWidth, compactLabel }) => {
  if (toolCalls.length === 0) return null;

  const overallStatus = getOverallStatus(toolCalls);
  const activeTool = getActiveTool(toolCalls);

  const isShellCommand = toolCalls.some(
    (t) => t.name === SHELL_COMMAND_NAME || t.name === SHELL_NAME,
  );
  const hasPending = !toolCalls.every(
    (t) => t.status === ToolCallStatus.Success,
  );

  const borderColor = isShellCommand
    ? theme.ui.symbol
    : hasPending
      ? theme.status.warning
      : theme.border.default;

  // Take only the first line of description to prevent multi-line shell scripts
  // from expanding the compact view (wrap="truncate-end" only handles width overflow,
  // not literal \n characters in the content)
  const activeToolDescription = activeTool.description
    ? activeTool.description.split('\n')[0]
    : '';

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      width={contentWidth}
      borderDimColor={hasPending}
      borderColor={borderColor}
      gap={0}
    >
      {/* Status line: icon + (summary | tool name + description) + count + elapsed */}
      <Box flexDirection="row">
        <ToolStatusIndicator status={overallStatus} name={activeTool.name} />
        <Box flexGrow={1}>
          <Text wrap="truncate-end">
            {compactLabel
              ? renderSummaryHeader(compactLabel, toolCalls.length)
              : renderDefaultHeader(
                  activeTool.name,
                  activeToolDescription,
                  toolCalls.length,
                )}
          </Text>
        </Box>
        <ToolElapsedTime
          status={overallStatus}
          executionStartTime={activeTool.executionStartTime}
          timeoutMs={getShellTimeoutMs(activeTool)}
        />
      </Box>

      {/* Hint line */}
      <Text color={theme.text.secondary}>
        {t('Press Ctrl+O to show full tool output')}
      </Text>
    </Box>
  );
};
