/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
import type { IndividualToolCallDisplay } from '../../types.js';
import { mapCoreStatusToDisplayStatus, ToolCallStatus } from '../../types.js';
import { theme } from '../../semantic-colors.js';
import { INDENT } from '../../constants/messageLayout.js';

/**
 * Height of the ToolGroupSummary component (single line).
 * Used by staticHeight calculations in ToolGroupMessage.
 */
export const TOOL_GROUP_SUMMARY_HEIGHT = 1;

interface ToolGroupSummaryProps {
  toolCalls: IndividualToolCallDisplay[];
  terminalWidth: number;
}

/**
 * Collapsed summary view for a ToolGroup (FoldLevel.GroupCollapsed).
 *
 * Renders a single line like:
 *   ▸ 3 tool calls (Read, Write, Bash) — completed
 *   ▸ 2 tool calls (Read, Bash) — 1 running
 */
export const ToolGroupSummary: React.FC<ToolGroupSummaryProps> = ({
  toolCalls,
  terminalWidth,
}) => {
  const summary = useMemo(() => {
    // Deduplicate tool names, preserving order
    const uniqueNames: string[] = [];
    const seen = new Set<string>();
    for (const tool of toolCalls) {
      if (!seen.has(tool.name)) {
        seen.add(tool.name);
        uniqueNames.push(tool.name);
      }
    }

    // Count by status category
    let executing = 0;
    let errors = 0;
    let pending = 0;
    for (const tool of toolCalls) {
      const displayStatus = mapCoreStatusToDisplayStatus(tool.status);
      if (displayStatus === ToolCallStatus.Executing) {
        executing++;
      } else if (displayStatus === ToolCallStatus.Error) {
        errors++;
      } else if (
        displayStatus === ToolCallStatus.Pending ||
        displayStatus === ToolCallStatus.Confirming
      ) {
        pending++;
      }
    }

    // Build status suffix
    let statusText: string;
    let statusColor: string;
    if (executing > 0) {
      statusText = `${executing} running`;
      statusColor = theme.ui.active;
    } else if (errors > 0) {
      statusText = `${errors} error${errors > 1 ? 's' : ''}`;
      statusColor = theme.status.error;
    } else if (pending > 0) {
      statusText = `${pending} pending`;
      statusColor = theme.text.secondary;
    } else {
      statusText = 'completed';
      statusColor = theme.status.success;
    }

    // Truncate tool names to fit terminal width
    const toolCount = toolCalls.length;
    const prefix = `\u25B8 ${toolCount} tool call${toolCount !== 1 ? 's' : ''} (`;
    const suffix = `) \u2014 ${statusText}`;
    const maxNamesWidth =
      terminalWidth -
      INDENT.TOOL_HEADER -
      prefix.length -
      suffix.length -
      INDENT.TOOL_GROUP_PADDING_RIGHT;

    let namesStr = uniqueNames.join(', ');
    if (namesStr.length > maxNamesWidth && maxNamesWidth > 3) {
      namesStr = namesStr.slice(0, maxNamesWidth - 1) + '\u2026';
    }

    return { prefix, namesStr, suffix, statusText, statusColor };
  }, [toolCalls, terminalWidth]);

  return (
    <Box paddingLeft={INDENT.TOOL_HEADER} flexDirection="row">
      <Text color={theme.border.default}>{summary.prefix}</Text>
      <Text color={theme.text.primary}>{summary.namesStr}</Text>
      <Text color={theme.border.default}>{') \u2014 '}</Text>
      <Text color={summary.statusColor}>{summary.statusText}</Text>
    </Box>
  );
};
