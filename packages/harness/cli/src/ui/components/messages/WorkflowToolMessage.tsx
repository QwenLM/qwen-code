/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { IndividualToolCallDisplay } from '../../types.js';
import { ToolResultDisplay } from './ToolResultDisplay.js';
import { ToolStatusIndicator } from './ToolShared.js';
import { ToolContainer } from './ToolContainer.js';
import { theme } from '../../semantic-colors.js';
import type { TextEmphasis } from './ToolMessage.js';
import { CoreToolCallStatus } from '@qwen-code/core';

interface WorkflowToolMessageProps extends IndividualToolCallDisplay {
  availableTerminalHeight?: number;
  terminalWidth: number;
  emphasis?: TextEmphasis;
  renderOutputAsMarkdown?: boolean;
  isFirst: boolean;
  borderColor: string;
  borderDimColor: boolean;
  maxOutputLines?: number;
}

export const WorkflowToolMessage: React.FC<WorkflowToolMessageProps> = ({
  name,
  description,
  resultDisplay,
  status,
  availableTerminalHeight,
  terminalWidth,
  emphasis = 'medium',
  renderOutputAsMarkdown = true,
  isFirst,
  borderColor,
  borderDimColor,
  maxOutputLines,
}) => {
  const showResult = resultDisplay !== undefined && resultDisplay !== '';
  const nameColor =
    emphasis === 'low' ? theme.text.secondary : theme.text.primary;

  const header = (
    <>
      <ToolStatusIndicator status={status} />
      <Box overflow="hidden" height={1} flexGrow={1} flexShrink={1}>
        <Text strikethrough={status === CoreToolCallStatus.Cancelled} wrap="truncate">
          <Text color={nameColor} bold>
            {name}
          </Text>
          {description ? (
            <Text color={theme.text.response}>({description})</Text>
          ) : null}
        </Text>
      </Box>
    </>
  );

  return (
    <ToolContainer
      header={header}
      terminalWidth={terminalWidth}
      sticky
      stickyProps={{ isFirst, borderColor, borderDimColor }}
    >
      {showResult ? (
        <ToolResultDisplay
          resultDisplay={resultDisplay}
          availableTerminalHeight={availableTerminalHeight}
          terminalWidth={terminalWidth}
          renderOutputAsMarkdown={renderOutputAsMarkdown}
          hasFocus={false}
          maxLines={maxOutputLines}
          overflowDirection="top"
        />
      ) : null}
    </ToolContainer>
  );
};
