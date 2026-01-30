/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { theme } from '../semantic-colors.js';

export const ContextUsageDisplay = ({
  promptTokenCount,
  terminalWidth,
  contextWindowSize,
}: {
  promptTokenCount: number;
  terminalWidth: number;
  contextWindowSize: number;
}) => {
  if (promptTokenCount === 0) {
    return null;
  }

  const percentage = promptTokenCount / contextWindowSize;
  const percentageUsed = (percentage * 100).toFixed(1);

  const label = terminalWidth < 100 ? '% used' : '% context used';

  return (
    <Text color={theme.text.secondary}>
      {percentageUsed}
      {label}
    </Text>
  );
};
