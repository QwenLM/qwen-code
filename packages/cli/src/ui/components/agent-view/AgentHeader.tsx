/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Compact header for agent tabs, visually distinct from the
 * main view's boxed logo header. Shows model, working directory, and git
 * branch in a bordered info panel.
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { shortenPath, tildeifyPath } from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';

interface AgentHeaderProps {
  modelId: string;
  modelName?: string;
  workingDirectory: string;
  gitBranch?: string;
}

export const AgentHeader: React.FC<AgentHeaderProps> = ({
  modelId,
  modelName,
  workingDirectory,
  gitBranch,
}) => {
  const { columns: terminalWidth } = useTerminalSize();
  const maxPathLen = Math.max(20, terminalWidth - 12);
  const displayPath = shortenPath(tildeifyPath(workingDirectory), maxPathLen);

  const modelText =
    modelName && modelName !== modelId ? `${modelId} (${modelName})` : modelId;

  return (
    <Box
      flexDirection="column"
      marginX={2}
      marginTop={1}
      borderStyle="round"
      borderColor={theme.border.default}
      paddingX={1}
    >
      <Text>
        <Text color={theme.text.secondary}>{'Model:  '}</Text>
        <Text color={theme.text.primary}>{modelText}</Text>
      </Text>
      <Text>
        <Text color={theme.text.secondary}>{'Path:   '}</Text>
        <Text color={theme.text.primary}>{displayPath}</Text>
      </Text>
      {gitBranch && (
        <Text>
          <Text color={theme.text.secondary}>{'Branch: '}</Text>
          <Text color={theme.text.primary}>{gitBranch}</Text>
        </Text>
      )}
    </Box>
  );
};
