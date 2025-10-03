/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { SummaryProps } from '../../types.js';
import Spinner from 'ink-spinner';
import { Colors } from '../../colors.js';

export interface SummaryDisplayProps {
  summary: SummaryProps;
}

/*
 * Summary messages appear when the /chat summary command is run, and show a loading spinner
 * while summary generation is in progress, followed up by success confirmation.
 */
export const SummaryMessage: React.FC<SummaryDisplayProps> = ({ summary }) => {
  const getText = () => {
    if (summary.isPending) {
      switch (summary.stage) {
        case 'generating':
          return 'Generating project summary...';
        case 'saving':
          return 'Saving project summary...';
        default:
          return 'Processing summary...';
      }
    }
    const baseMessage = 'Project summary generated and saved successfully!';
    if (summary.filePath) {
      return `${baseMessage} Saved to: ${summary.filePath}`;
    }
    return baseMessage;
  };

  const getIcon = () => {
    if (summary.isPending) {
      return <Spinner type="dots" />;
    }
    return <Text color={Colors.AccentGreen}>✅</Text>;
  };

  return (
    <Box flexDirection="row">
      <Box marginRight={1}>{getIcon()}</Box>
      <Box>
        <Text
          color={summary.isPending ? Colors.AccentPurple : Colors.AccentGreen}
        >
          {getText()}
        </Text>
      </Box>
    </Box>
  );
};
