/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Text, Box } from 'ink';
import { theme } from '../../semantic-colors.js';
import { getDisplayString } from '@qwen-code/core';
import { useConfig, useModel } from '../../contexts/ConfigContext.js';
import { INDENT } from '../../constants/messageLayout.js';

interface ModelMessageProps {
  model: string;
}

export const ModelMessage: React.FC<ModelMessageProps> = ({ model }) => {
  const config = useConfig();
  const listed = useModel(config, model);
  return (
    <Box marginLeft={INDENT.FEED_LEFT_OFFSET}>
      <Text color={theme.ui.comment} italic>
        Responding with {getDisplayString(listed, model)}
      </Text>
    </Box>
  );
};
