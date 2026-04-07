/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { Config } from '@qwen-code/qwen-code-core';

interface ModeIndicatorProps {
  config: Config | null;
}

/**
 * Displays the currently active mode with icon, name, and color.
 * Shows "General" when no mode is active.
 */
export const ModeIndicator: React.FC<ModeIndicatorProps> = ({ config }) => {
  if (!config) {
    return null;
  }

  const currentMode = config.getCurrentMode();

  if (!currentMode) {
    return (
      <Box>
        <Text color="dim">
          ⚙️ General
        </Text>
      </Box>
    );
  }

  const { icon, displayName, color } = currentMode.config;
  const displayColor = color || '#3498DB';

  return (
    <Box>
      <Text color={displayColor}>
        {icon} {displayName}
      </Text>
    </Box>
  );
};
