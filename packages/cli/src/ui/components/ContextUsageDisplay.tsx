/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { tokenLimit } from '@qwen-code/qwen-code-core';

export const ContextUsageDisplay = ({
  promptTokenCount,
  model,
  terminalWidth,
  contextWindowSize,
}: {
  promptTokenCount: number;
  model: string;
  terminalWidth: number;
  contextWindowSize?: number;
}) => {
  const configuredLimit =
    contextWindowSize && contextWindowSize > 0 ? contextWindowSize : undefined;
  const percentage =
    promptTokenCount / tokenLimit(model, 'input', configuredLimit);
  const percentageLeft = ((1 - percentage) * 100).toFixed(0);

  const label = terminalWidth < 100 ? '%' : '% context left';

  return (
    <Text color={theme.text.secondary}>
      ({percentageLeft}
      {label})
    </Text>
  );
};
