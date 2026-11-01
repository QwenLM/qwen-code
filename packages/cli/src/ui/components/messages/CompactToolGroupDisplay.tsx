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
import wrapAnsi from 'wrap-ansi';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import type { AnsiOutputDisplay } from '@qwen-code/qwen-code-core';
import {
  STATUS_INDICATOR_WIDTH,
  ToolStatusIndicator,
} from '../shared/ToolStatusIndicator.js';
import { ToolElapsedTime } from '../shared/ToolElapsedTime.js';
import { formatDuration } from '../../utils/formatters.js';

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
  contentWidth: number,
): number {
  if (toolCalls.length === 0) return 0;

  const overallStatus = getOverallStatus(toolCalls);
  const activeTool = getActiveTool(toolCalls);
  const isActive = isToolGroupActive(overallStatus);
  const summary = `${buildToolSummary(toolCalls, isActive)}${isActive ? '…' : ''}`;
  const hint = getActiveToolHint(toolCalls);
  const summaryWidth = Math.max(
    1,
    contentWidth -
      STATUS_INDICATOR_WIDTH -
      getElapsedTimeReservedWidth(activeTool, overallStatus),
  );
  const wrappedSummary = wrapAnsi(summary, summaryWidth, {
    hard: true,
    trim: false,
  });

  return Math.max(1, wrappedSummary.split('\n').length) + (hint ? 1 : 0);
}

export const CompactToolGroupDisplay: React.FC<
  CompactToolGroupDisplayProps
> = ({ toolCalls, contentWidth }) => {
  if (toolCalls.length === 0) return null;

  const overallStatus = getOverallStatus(toolCalls);
  const activeTool = getActiveTool(toolCalls);
  const isActive = isToolGroupActive(overallStatus);
  const hint = getActiveToolHint(toolCalls);

  return (
    <Box flexDirection="column" width={contentWidth} gap={0}>
      <Box flexDirection="row">
        <ToolStatusIndicator status={overallStatus} name={activeTool.name} />
        <Box flexGrow={1}>
          <Text wrap="wrap" bold>
            {buildToolSummary(toolCalls, isActive)}
            {isActive && <Text key="ellipsis">…</Text>}
          </Text>
        </Box>
        <ToolElapsedTime
          status={overallStatus}
          executionStartTime={activeTool.executionStartTime}
          timeoutMs={getShellTimeoutMs(activeTool)}
        />
      </Box>
      {hint && (
        <Box paddingLeft={STATUS_INDICATOR_WIDTH}>
          <Text dimColor wrap="truncate-end">
            ⎿ {hint}
          </Text>
        </Box>
      )}
    </Box>
  );
};
