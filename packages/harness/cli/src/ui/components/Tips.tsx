/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { DEFAULT_CONTEXT_FILENAME, type Config } from '@qwen-code/core';

interface TipsProps {
  config: Config;
}

export const Tips: React.FC<TipsProps> = ({ config }) => {
  const memoryMdFileCount = config.getMemoryMdFileCount();

  return (
    <Box flexDirection="column">
      <Text color={theme.text.primary} wrap="truncate-end">
        Tips for getting started:
      </Text>
      {memoryMdFileCount === 0 && (
        <Text color={theme.text.primary} wrap="truncate-end">
          1. Create <Text bold>{DEFAULT_CONTEXT_FILENAME}</Text> files to
          customize your interactions
        </Text>
      )}
      <Text color={theme.text.primary} wrap="truncate-end">
        {memoryMdFileCount === 0 ? '2.' : '1.'}{' '}
        <Text color={theme.text.secondary}>/help</Text> for more information
      </Text>
      <Text color={theme.text.primary} wrap="truncate-end">
        {memoryMdFileCount === 0 ? '3.' : '2.'} Ask coding questions, edit code
        or run commands
      </Text>
      <Text color={theme.text.primary} wrap="truncate-end">
        {memoryMdFileCount === 0 ? '4.' : '3.'} Be specific for the best results
      </Text>
    </Box>
  );
};
