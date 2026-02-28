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
import { useConfig } from '../../contexts/ConfigContext.js';
import { getToolGroupBorderAppearance } from '../../utils/borderStyles.js';

interface ToolGroupMessageProps {
  groupId: number;
  toolCalls: IndividualToolCallDisplay[];
  availableTerminalHeight?: number;
  contentWidth: number;
  isFocused?: boolean;
  activeShellPtyId?: number | null;
  embeddedShellFocused?: boolean;
  onShellInputSubmit?: (input: string) => void;
}

const TOOL_MESSAGE_HORIZONTAL_MARGIN = 4;

export const ToolGroupMessage: React.FC<ToolGroupMessageProps> = ({
  toolCalls,
  availableTerminalHeight,
  contentWidth,
  isFocused = true,
  activeShellPtyId,
  embeddedShellFocused,
}) => {
  const config = useConfig();

  const { borderColor, borderDimColor } = useMemo(
    () =>
      getToolGroupBorderAppearance(
        toolCalls,
        activeShellPtyId,
        embeddedShellFocused,
      ),
    [toolCalls, activeShellPtyId, embeddedShellFocused],
  );

  const staticHeight = 2;
  const contentWidthCalculated = contentWidth - TOOL_MESSAGE_HORIZONTAL_MARGIN;

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
      borderStyle="round"
      width={contentWidth}
      paddingRight={TOOL_MESSAGE_HORIZONTAL_MARGIN}
      borderDimColor={borderDimColor}
      borderColor={borderColor}
      gap={1}
    >
      {toolCalls.map((tool) => {
        const isConfirming = toolAwaitingApproval?.callId === tool.callId;
        return (
          <Box key={tool.callId} flexDirection="column" minHeight={1}>
            <Box flexDirection="row" alignItems="center">
              <ToolMessage
                {...tool}
                availableTerminalHeight={availableTerminalHeightPerToolMessage}
                contentWidth={contentWidthCalculated}
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
                  contentWidth={contentWidthCalculated}
                />
              )}
            {tool.outputFile && (
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
              >
                <Text color={theme.text.primary}>
                  Output too long and was saved to: {tool.outputFile}
                </Text>
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
};
