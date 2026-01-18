/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';
import { Box, Text } from 'ink';
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
  terminalWidth: number;
  isFocused?: boolean;
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  onShellInputSubmit?: (input: string) => void;
}

// Main component renders the border and maps the tools using ToolMessage
export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  toolCalls,
  availableTerminalHeight,
  terminalWidth,
  isFocused = true,
  activeShellPtyId,
  embeddedShellFocused,
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

  const borderDimColor =
    hasPending && (!isShellCommand || !isEmbeddedShellFocused);

  const staticHeight = /* border */ 2 + /* marginBottom */ 1;
  // Account for borders and padding (2 for left/right border, 2 for padding)
  const innerWidth = terminalWidth - 4;

  // only prompt for tool approval on the first 'confirming' tool in the list
  // note, after the CTA, this automatically moves over to the next 'confirming' tool
  const toolAwaitingApproval = useMemo(
    () => toolCalls.find((tc) => tc.status === ToolCallStatus.Confirming),
    [toolCalls],
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

  return (
    <Box
      flexDirection="column"
      /*
        This width constraint is highly important and protects us from an Ink rendering bug.
        Since the ToolGroup can typically change rendering states frequently, it can cause
        Ink to render the border of the box incorrectly and span multiple lines and even
        cause tearing.
      */
      width={terminalWidth}
      marginLeft={1}
    >
      {toolCalls.map((tool, index) => {
        const isConfirming = toolAwaitingApproval?.callId === tool.callId;
        const isFirst = index === 0;

        return (
          <Box
            key={tool.callId}
            flexDirection="column"
            minHeight={1}
            width={terminalWidth - 1}
          >
            {/* Header with top border (only for first item) and left/right borders */}
            <Box
              borderStyle="round"
              borderTop={isFirst}
              borderBottom={false}
              borderLeft={true}
              borderRight={true}
              borderColor={borderColor}
              borderDimColor={borderDimColor}
              width={terminalWidth - 1}
              paddingX={1}
            >
              <ToolMessage
                {...tool}
                availableTerminalHeight={availableTerminalHeightPerToolMessage}
                terminalWidth={innerWidth}
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
            {/* Confirmation and output sections with left/right borders */}
            <Box
              borderLeft={true}
              borderRight={true}
              borderTop={false}
              borderBottom={false}
              borderColor={borderColor}
              borderDimColor={borderDimColor}
              flexDirection="column"
              borderStyle="round"
              paddingLeft={1}
              paddingRight={1}
              width={terminalWidth - 1}
            >
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
                    terminalWidth={innerWidth}
                  />
                )}
              {tool.outputFile && (
                <Box>
                  <Text color={theme.text.primary}>
                    Output too long and was saved to: {tool.outputFile}
                  </Text>
                </Box>
              )}
            </Box>
          </Box>
        );
      })}
      {/* Bottom border - kept separate to ensure proper alignment */}
      {toolCalls.length > 0 && (
        <Box
          height={0}
          width={terminalWidth - 1}
          borderLeft={true}
          borderRight={true}
          borderTop={false}
          borderBottom={true}
          borderColor={borderColor}
          borderDimColor={borderDimColor}
          borderStyle="round"
        />
      )}
    </Box>
  );
};
