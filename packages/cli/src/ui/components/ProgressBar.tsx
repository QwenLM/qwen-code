/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';

interface ProgressBarProps {
  value: number; // 0 to 100
  width: number;
  warningThreshold?: number;
  label?: string;
  activeColor?: string;
  inactiveColor?: string;
  activeChar?: string;
  inactiveChar?: string;
}

export const ProgressBar: React.FC<ProgressBarProps> = ({
  value,
  width,
  warningThreshold = 80,
  label,
  activeColor,
  inactiveColor,
  activeChar = '▬',
  inactiveChar = '▬',
}) => {
  const safeValue = Math.min(Math.max(value, 0), 100);
  const activeChars = Math.ceil((safeValue / 100) * width);
  const inactiveChars = width - activeChars;

  let color = theme.status.success;
  if (safeValue >= 100) {
    color = theme.status.error;
  } else if (safeValue >= warningThreshold) {
    color = theme.status.warning;
  }

  return (
    <Box flexDirection="row">
      <Text color={activeColor ?? color}>{activeChar.repeat(activeChars)}</Text>
      <Text color={inactiveColor ?? theme.border.default}>
        {inactiveChar.repeat(inactiveChars)}
      </Text>
      {label && <Text color={theme.text.secondary}> {label}</Text>}
    </Box>
  );
};
