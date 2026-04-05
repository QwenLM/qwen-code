/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { t } from '../../i18n/index.js';
import {
  TipHistory,
  selectTip,
  tipRegistry,
  type TipContext,
} from '../../services/tips/index.js';

/**
 * Shared TipHistory instance for the session. Loaded once at import time
 * so both startup tips and post-response tips use the same state.
 */
let _tipHistory: TipHistory | null = null;
export function getTipHistory(): TipHistory {
  if (!_tipHistory) {
    _tipHistory = TipHistory.load();
  }
  return _tipHistory;
}

/**
 * Select a startup tip. Extracted as a standalone function for clarity.
 * Called once via useMemo([], ...) — recordShown writes to disk.
 */
function pickStartupTip(): string {
  const history = getTipHistory();
  const context: TipContext = {
    lastPromptTokenCount: 0,
    contextWindowSize: 0,
    compressionThreshold: 0,
    sessionPromptCount: 0,
    sessionCount: history.sessionCount,
    platform: process.platform,
  };

  const tip = selectTip('startup', context, tipRegistry, history);
  if (tip) {
    history.recordShown(tip.id, 0);
    return tip.content;
  }

  // Fallback — should not happen with the current registry
  return 'Type / to see all available commands.';
}

export const Tips: React.FC = () => {
  const selectedTip = useMemo(() => pickStartupTip(), []);

  return (
    <Box marginLeft={2} marginRight={2}>
      <Text color={theme.text.secondary}>
        {t('Tips: ')}
        {t(selectedTip)}
      </Text>
    </Box>
  );
};
