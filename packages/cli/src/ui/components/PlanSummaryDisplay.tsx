/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { MarkdownDisplay } from '../utils/MarkdownDisplay.js';
import { Colors } from '../colors.js';
import type { PlanResultDisplay } from '@qwen-code/qwen-code-core';

interface PlanSummaryDisplayProps {
  data: PlanResultDisplay;
  availableHeight?: number;
  childWidth: number;
}

export const PlanSummaryDisplay: React.FC<PlanSummaryDisplayProps> = ({
  data,
  availableHeight,
  childWidth,
}) => {
  const { message, plan } = data;

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color={Colors.AccentGreen} wrap="wrap">
          {message}
        </Text>
      </Box>
      <MarkdownDisplay
        text={plan}
        isPending={false}
        availableTerminalHeight={availableHeight}
        terminalWidth={childWidth}
      />
    </Box>
  );
};
