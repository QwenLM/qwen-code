/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolCallStatus } from '../../types.js';
import { ToolMessage } from './ToolMessage.js';
import { ToolConfirmationMessage } from './ToolConfirmationMessage.js';
import { theme } from '../../semantic-colors.js';
import { SHELL_COMMAND_NAME, SHELL_NAME } from '../../constants.js';
import { useConfig } from '../../contexts/ConfigContext.js';

interface ToolGroupMessageProps {
  groupId: number;
  toolCalls: IndividualToolCallDisplay[];
  availableTerminalHeight?: number;
  contentWidth: number;
  isFocused?: boolean;
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  onShellInputSubmit?: (input: string) => void;
  /** Pre-computed count of write ops to managed-auto-memory files. */
  memoryWriteCount?: number;
  /** Pre-computed count of read ops from managed-auto-memory files. */
  memoryReadCount?: number;
}

// Main component renders the border and maps the tools using ToolMessage
export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  toolCalls,
  availableTerminalHeight,
  contentWidth,
  isFocused = true,
  activeShellPtyId,
  embeddedShellFocused,
  memoryWriteCount,
  memoryReadCount,
}) => {
  const isEmbeddedShellFocused =
    embeddedShellFocused &&
    toolCalls.some(
      (t) =>
        t.ptyId === activeShellPtyId && t.status === ToolCallStatus.Executing,
    );

  const hasPending = !toolCalls.every(
    (t) => t.status === ToolCallStatus.Success,
  );

  const config = useConfig();
  const isShellCommand = toolCalls.some(
    (t) => t.name === SHELL_COMMAND_NAME || t.name === SHELL_NAME,
  );
  const borderColor =
    isShellCommand || isEmbeddedShellFocused
      ? theme.ui.symbol
      : hasPending
        ? theme.status.warning
        : theme.border.default;

  const staticHeight = /* border */ 2 + /* marginBottom */ 1;
  // account for border (2 chars) and padding (2 chars)
  const innerWidth = contentWidth - 4;

  // only prompt for tool approval on the first 'confirming' tool in the list
  // note, after the CTA, this automatically moves over to the next 'confirming' tool
  const toolAwaitingApproval = useMemo(
    () => toolCalls.find((tc) => tc.status === ToolCallStatus.Confirming),
    [toolCalls],
  );

  // Detect if this is a "memory-only" group (all tool calls are memory ops)
  const isMemoryOnlyGroup = useMemo(
    () => toolCalls.length > 0 && toolCalls.every((t) => t.isMemoryOp != null),
    [toolCalls],
  );

  const allComplete = useMemo(
    () =>
      toolCalls.every(
        (t) =>
          t.status === ToolCallStatus.Success ||
          t.status === ToolCallStatus.Error,
      ),
    [toolCalls],
  );

  // Expand/collapse state for memory-only groups
  const [isExpanded, setIsExpanded] = useState(false);

  useInput(
    (_input, key) => {
      if (key.ctrl && _input === 'o') {
        setIsExpanded((prev) => !prev);
      }
    },
    { isActive: isFocused && isMemoryOnlyGroup && allComplete },
  );

  let countToolCallsWithResults = 0;
  for (const tool of toolCalls) {
    if (tool.resultDisplay !== undefined && tool.resultDisplay !== '') {
      countToolCallsWithResults++;
    }
  }
  const countOneLineToolCalls = toolCalls.length - countToolCallsWithResults;
  const availableTerminalHeightPerToolMessage = availableTerminalHeight
    ? Math.max(
        Math.floor(
          (availableTerminalHeight - staticHeight - countOneLineToolCalls) /
            Math.max(1, countToolCallsWithResults),
        ),
        1,
      )
    : undefined;

  // For completed memory-only groups, show a compact summary instead of individual tool calls
  if (isMemoryOnlyGroup && allComplete && !isExpanded) {
    const readCount = memoryReadCount ?? 0;
    const writeCount = memoryWriteCount ?? 0;
    return (
      <Box
        flexDirection="column"
        borderStyle="round"
        width={contentWidth}
        borderColor={theme.border.default}
      >
        {readCount > 0 && (
          <Box paddingLeft={1}>
            <Text>
              {'● '}
              <Text>
                Recalled {readCount} {readCount === 1 ? 'memory' : 'memories'}
              </Text>
              <Text dimColor> (ctrl+o to expand)</Text>
            </Text>
          </Box>
        )}
        {writeCount > 0 && (
          <Box paddingLeft={1}>
            <Text>
              {'● '}
              <Text>
                Wrote {writeCount} {writeCount === 1 ? 'memory' : 'memories'}
              </Text>
              <Text dimColor> (ctrl+o to expand)</Text>
            </Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      /*
        This width constraint is highly important and protects us from an Ink rendering bug.
        Since the ToolGroup can typically change rendering states frequently, it can cause
        Ink to render the border of the box incorrectly and span multiple lines and even
        cause tearing.
      */
      width={contentWidth}
      borderDimColor={
        hasPending && (!isShellCommand || !isEmbeddedShellFocused)
      }
      borderColor={borderColor}
      gap={1}
    >
      {/* Memory badge for mixed groups (some memory ops + other ops) */}
      {!isMemoryOnlyGroup && ((memoryWriteCount ?? 0) > 0 || (memoryReadCount ?? 0) > 0) && (() => {
        const parts: string[] = [];
        if ((memoryReadCount ?? 0) > 0) {
          const n = memoryReadCount!;
          parts.push(`Recalled ${n} ${n === 1 ? 'memory' : 'memories'}`);
        }
        if ((memoryWriteCount ?? 0) > 0) {
          const n = memoryWriteCount!;
          parts.push(`Wrote ${n} ${n === 1 ? 'memory' : 'memories'}`);
        }
        return (
          <Box paddingLeft={1}>
            <Text dimColor>● {parts.join(', ')}</Text>
          </Box>
        );
      })()}
      {/* Expanded memory-only group header */}
      {isMemoryOnlyGroup && isExpanded && (
        <Box paddingLeft={1}>
          <Text dimColor>● Memory operations <Text dimColor>(ctrl+o to collapse)</Text></Text>
        </Box>
      )}
      {toolCalls.map((tool) => {
        const isConfirming = toolAwaitingApproval?.callId === tool.callId;
        return (
          <Box key={tool.callId} flexDirection="column" minHeight={1}>
            <Box flexDirection="row" alignItems="center">
              <ToolMessage
                {...tool}
                availableTerminalHeight={availableTerminalHeightPerToolMessage}
                contentWidth={innerWidth}
                emphasis={
                  isConfirming
                    ? 'high'
                    : toolAwaitingApproval
                      ? 'low'
                      : 'medium'
                }
                activeShellPtyId={activeShellPtyId}
                embeddedShellFocused={embeddedShellFocused}
                config={config}
              />
            </Box>
            {tool.status === ToolCallStatus.Confirming &&
              isConfirming &&
              tool.confirmationDetails && (
                <ToolConfirmationMessage
                  confirmationDetails={tool.confirmationDetails}
                  config={config}
                  isFocused={isFocused}
                  availableTerminalHeight={
                    availableTerminalHeightPerToolMessage
                  }
                  contentWidth={innerWidth}
                />
              )}
          </Box>
        );
      })}
    </Box>
  );
};
