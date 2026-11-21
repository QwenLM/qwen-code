/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import {
  buildToolSummary,
  getActiveToolHint,
} from '../../utils/tool-group-summary.js';
export {
  buildToolSummary,
  isCollapsibleTool,
} from '../../utils/tool-group-summary.js';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import type { AnsiOutputDisplay } from '@qwen-code/qwen-code-core';
import {
  STATUS_INDICATOR_WIDTH,
  ToolStatusIndicator,
} from '../shared/ToolStatusIndicator.js';
import { ToolElapsedTime } from '../shared/ToolElapsedTime.js';
import { formatDuration } from '../../utils/formatters.js';
import { theme } from '../../semantic-colors.js';

interface CompactToolGroupDisplayProps {
  toolCalls: IndividualToolCallDisplay[];
  contentWidth: number;
}

const ELAPSED_TIME_MARGIN_LEFT = 1;
const EXECUTING_ELAPSED_TIME_RESERVED_LABEL = '99h 59m 59s';

// Priority: Confirming > Executing > Error > Canceled > Pending > Success
export function getOverallStatus(
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

function isToolGroupActive(status: ToolCallStatus): boolean {
  return (
    status === ToolCallStatus.Executing ||
    status === ToolCallStatus.Pending ||
    status === ToolCallStatus.Confirming
  );
}

function getElapsedTimeReservedWidth(
  tool: IndividualToolCallDisplay,
  status: ToolCallStatus,
): number {
  if (status !== ToolCallStatus.Executing) return 0;

  const timeoutMs = getShellTimeoutMs(tool);
  let label = EXECUTING_ELAPSED_TIME_RESERVED_LABEL;
  if (timeoutMs != null && timeoutMs > 0) {
    const maxElapsedStr = formatDuration(timeoutMs, {
      hideTrailingZeros: true,
    });
    label = `(${maxElapsedStr} · timeout ${maxElapsedStr})`;
  }

  return ELAPSED_TIME_MARGIN_LEFT + stringWidth(label);
}

export function estimateCompactToolGroupHeight(
  toolCalls: IndividualToolCallDisplay[],
  _contentWidth: number,
): number {
  return toolCalls.length === 0 ? 0 : 1;
}

export const CompactToolGroupDisplay: React.FC<
  CompactToolGroupDisplayProps
> = ({ toolCalls, contentWidth }) => {
  if (toolCalls.length === 0) return null;

  const overallStatus = getOverallStatus(toolCalls);
  const activeTool = getActiveTool(toolCalls);
  const isActive = isToolGroupActive(overallStatus);
  const hint = getActiveToolHint(toolCalls);
  const timerWidth = Math.min(
    getElapsedTimeReservedWidth(activeTool, overallStatus),
    Math.max(0, contentWidth - STATUS_INDICATOR_WIDTH - 12),
  );

  return (
    <Box flexDirection="row" width={contentWidth} height={1}>
      <ToolStatusIndicator status={overallStatus} name={activeTool.name} />
      <Box flexGrow={1} minWidth={0}>
        <Text
          wrap="truncate-end"
          color={isActive ? theme.text.primary : theme.text.secondary}
        >
          {buildToolSummary(toolCalls, isActive)}
          {isActive && <Text key="ellipsis">…</Text>}
          {hint && (
            <Text color={theme.text.secondary}>
              {' · '}
              {hint}
            </Text>
          )}
        </Text>
      </Box>
      {timerWidth > 0 && (
        <Box
          width={timerWidth}
          flexShrink={0}
          justifyContent="flex-end"
          overflow="hidden"
        >
          <ToolElapsedTime
            status={overallStatus}
            executionStartTime={activeTool.executionStartTime}
            timeoutMs={getShellTimeoutMs(activeTool)}
          />
        </Box>
      )}
    </Box>
  );
};

export const CompactToolCallList: React.FC<CompactToolGroupDisplayProps> = ({
  toolCalls,
  contentWidth,
}) => (
  <Box flexDirection="column" width={contentWidth}>
    {toolCalls.map((tool) => (
      <CompactToolGroupDisplay
        key={tool.callId}
        toolCalls={[tool]}
        contentWidth={contentWidth}
      />
    ))}
  </Box>
);
