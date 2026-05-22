/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { useThinkingPulse } from '../hooks/useThinkingPulse.js';
import { theme } from '../semantic-colors.js';
import { THINKING_PREFIX } from '../constants.js';
import { formatDuration } from '../utils/formatters.js';
import { t } from '../../i18n/index.js';

/**
 * Renders a single line above the composer while the model is still in
 * its thinking phase and no visible text or tool output has reached the
 * stream yet. Mirrors Claude Code's "✻ Thinking…" indicator, with the
 * elapsed timer added so a long pause does not look frozen.
 *
 *   ✻ Thinking… (4.2s)  ·  Ctrl+O for details
 *
 * Auto-hides whenever the underlying `useThinkingPulse` reports
 * inactive (turn ended, model emitted text/tool, etc.) and in verbose
 * / transcript mode where the full thought stream renders inline.
 */
export const ThinkingPulse: React.FC = () => {
  const pulse = useThinkingPulse();
  if (!pulse || !pulse.active) return null;
  const elapsed = formatDuration(Math.max(pulse.elapsedMs, 1000), {
    hideTrailingZeros: true,
  });
  return (
    <Box paddingLeft={2}>
      <Text color={theme.text.secondary} italic>
        {THINKING_PREFIX} {t('ui.thinkingPulse')}
        {' ('}
        {elapsed}
        {')  ·  '}
        {t('ui.thinkingPulseHint')}
      </Text>
    </Box>
  );
};
