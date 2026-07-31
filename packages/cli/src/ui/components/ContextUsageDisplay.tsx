/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';

/**
 * Format percentage for display, showing ">100" when exceeding limit.
 */
function formatPercentageUsed(percentage: number): string {
  if (percentage > 1) {
    return '>100';
  }
  return (percentage * 100).toFixed(1);
}

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

  const label = terminalWidth < 100 ? t('% used') : t('% context used');

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
