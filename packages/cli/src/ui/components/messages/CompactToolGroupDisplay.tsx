/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import { SHELL_COMMAND_NAME, SHELL_NAME } from '../../constants.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';
import { ToolStatusIndicator } from '../shared/ToolStatusIndicator.js';

interface CompactToolGroupDisplayProps {
  toolCalls: IndividualToolCallDisplay[];
  contentWidth: number;
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

export const CompactToolGroupDisplay: React.FC<
  CompactToolGroupDisplayProps
> = ({ toolCalls, contentWidth }) => {
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
      {/* Status line: icon + tool name + description */}
      <Box flexDirection="row">
        <ToolStatusIndicator
          status={overallStatus}
          name={activeTool.name}
          executionStartTime={activeTool.executionStartTime}
        />
        <Box flexGrow={1}>
          <Text wrap="truncate-end">
            <Text bold>{activeTool.name}</Text>
            {activeToolDescription ? (
              <Text color={theme.text.secondary}>
                {'  '}
                {activeToolDescription}
              </Text>
            ) : null}
          </Text>
        </Box>
      </Box>

      {/* Hint line */}
      <Text color={theme.text.secondary}>
        {t('Press Ctrl+O to show full tool output')}
      </Text>
    </Box>
  );
};
