/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import {
  contextUsageLabel,
  formatPercentageUsed,
} from '../utils/formatters.js';

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
  const percentageUsed = formatPercentageUsed(percentage);
  const isOverLimit = percentage > 1;

  const label = contextUsageLabel(terminalWidth);

  // Show warning when over limit
  if (isOverLimit) {
    return (
      <>
        <Text color={theme.status.error}>
          {percentageUsed}
          {label}
        </Text>
      </>
    );
  }

  return (
    <Text color={theme.text.secondary}>
      {percentageUsed}
      {label}
    </Text>
  );
};
