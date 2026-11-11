/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import {
  CoreToolCallStatus,
  isFailedScriptStatus,
  type CodeModeChildDisplay,
  type CodeModeDisplay,
} from '@qwen-code/core';
import { DenseToolMessage } from './DenseToolMessage.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import { FoldLevel } from '../../constants/messageLayout.js';
import { projectToolCallDisplay } from '../../utils/toolDisplayProjection.js';
import { theme } from '../../semantic-colors.js';
import { TOOL_OUTPUT_COMPACT_MAX_LINES } from '../../utils/toolLayoutUtils.js';
import type { IndividualToolCallDisplay } from '../../types.js';

interface CodeModeDisplayViewProps {
  display: CodeModeDisplay;
  terminalWidth: number;
  foldLevel?: FoldLevel;
  live?: boolean;
}

const isFailed = (status: CoreToolCallStatus) =>
  status === CoreToolCallStatus.Error ||
  status === CoreToolCallStatus.Cancelled;

// The hidden-lines label takes one of the maxLines rows.
const COLLAPSED_OUTPUT_LINES = TOOL_OUTPUT_COMPACT_MAX_LINES + 1;

function projectChild(
  child: CodeModeChildDisplay,
  live: boolean,
): IndividualToolCallDisplay {
  const tool = projectToolCallDisplay({
    toolUse: { id: child.callId, name: child.name, input: child.args },
    runtime: {
      // Historical poll receipts retain their state without running animations.
      status:
        !live && child.status === CoreToolCallStatus.Executing
          ? CoreToolCallStatus.Scheduled
          : child.status,
    },
  });
  return {
    ...tool,
    description: [
      tool.description,
      child.argsTruncated ? '[arguments truncated]' : undefined,
      child.notice ? `(${child.notice})` : undefined,
    ]
      .filter(Boolean)
      .join(' '),
    // Only failed calls carry an error, and it explains them better than their display.
    resultDisplay: child.error ?? child.resultDisplay,
  };
}

/** Script child calls as compact tool rows; failures start expanded. */
export const CodeModeDisplayView: React.FC<CodeModeDisplayViewProps> = ({
  display,
  terminalWidth,
  foldLevel = FoldLevel.GroupExpandedToolCollapsed,
  live = false,
}) => {
  const scriptFailed =
    display.status !== undefined && isFailedScriptStatus(display.status);
  const outputExpanded = scriptFailed || foldLevel === FoldLevel.FullyExpanded;
  return (
    <Box flexDirection="column">
      {display.children.map((child) => {
        const tool = projectChild(child, live);
        return (
          <DenseToolMessage
            key={tool.callId}
            {...tool}
            terminalWidth={terminalWidth}
            foldLevel={
              isFailed(tool.status) ? FoldLevel.FullyExpanded : foldLevel
            }
          />
        );
      })}
      {display.summary ? (
        <Box
          flexDirection="column"
          marginTop={display.children.length > 0 ? 1 : 0}
        >
          <Text color={theme.text.secondary}>Output</Text>
          <ToolResultDisplay
            resultDisplay={display.summary}
            terminalWidth={terminalWidth}
            renderOutputAsMarkdown={false}
            maxLines={outputExpanded ? undefined : COLLAPSED_OUTPUT_LINES}
            overflowDirection="bottom"
          />
        </Box>
      ) : null}
    </Box>
  );
};
