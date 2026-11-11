/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import {
  calculateTokenWarningState,
  calculateTokenWarningStateForContextWindow,
  getEffectiveContextWindowSize,
  getRawContextWindowSize,
} from '@qwen-code/core';
import { theme } from '../semantic-colors.js';
import { useConfig, useModel } from '../contexts/ConfigContext.js';
import { getContextUsagePercentage } from '../utils/contextUsage.js';
import { MIN_TERMINAL_WIDTH_FOR_FULL_LABEL } from '../constants.js';
import { useI18nService } from '../i18n/index.js';

export const ContextUsageDisplay = ({
  promptTokenCount,
  model,
  terminalWidth,
  contextWindowSize,
}: {
  promptTokenCount: number;
  model: string | undefined;
  terminalWidth: number;
  contextWindowSize?: number;
}) => {
  const i18n = useI18nService();
  // The core helpers read model limits from this session's Config, never a
  // process global. The two paths without a caller-resolved window also use it
  // as the window source; without that they would drop to the listed limit.
  const config = useConfig();
  const listed = useModel(config, model);
  const resolvedContextWindow =
    contextWindowSize ??
    (model ? config.getEffectiveContextWindow(listed, model) : undefined);
  const rawContextWindowSize =
    model && resolvedContextWindow && resolvedContextWindow > 0
      ? getRawContextWindowSize(listed, resolvedContextWindow)
      : resolvedContextWindow;
  const percentage =
    rawContextWindowSize && rawContextWindowSize > 0
      ? promptTokenCount / rawContextWindowSize
      : getContextUsagePercentage(
          promptTokenCount,
          model ? listed : undefined,
          resolvedContextWindow,
        );
  const percentageUsed = (percentage * 100).toFixed(0);

  let textColor = theme.text.secondary;
  if (rawContextWindowSize && rawContextWindowSize > 0) {
    const warningContextWindowSize = model
      ? getEffectiveContextWindowSize(listed, rawContextWindowSize)
      : rawContextWindowSize;
    const warningState = calculateTokenWarningStateForContextWindow(
      promptTokenCount,
      warningContextWindowSize,
    );
    if (warningState.isAtBlockingLimit || warningState.isAboveErrorThreshold) {
      textColor = theme.status.error;
    } else if (warningState.isAboveWarningThreshold) {
      textColor = theme.status.warning;
    }
  } else if (model) {
    const warningState = calculateTokenWarningState(
      promptTokenCount,
      listed,
      resolvedContextWindow,
    );
    if (warningState.isAtBlockingLimit || warningState.isAboveErrorThreshold) {
      textColor = theme.status.error;
    } else if (warningState.isAboveWarningThreshold) {
      textColor = theme.status.warning;
    }
  }

  const label =
    terminalWidth < MIN_TERMINAL_WIDTH_FOR_FULL_LABEL
      ? `${percentageUsed}%`
      : i18n.get('status.contextUsed', { percentage: percentageUsed });

  return <Text color={textColor}>{label}</Text>;
};
