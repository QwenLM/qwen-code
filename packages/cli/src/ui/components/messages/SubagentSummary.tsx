/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { AgentResultDisplay } from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { escapeAnsiCtrlCodes } from '../../utils/textUtils.js';
import { formatDuration, formatTokenCount } from '../../utils/formatters.js';
import {
  SUBAGENT_GROUP_GLYPH,
  SUBAGENT_GLYPH_COMPLETED,
  SUBAGENT_GLYPH_FAILED,
  SUBAGENT_GLYPH_CANCELLED,
} from '../../constants/subagentGlyphs.js';
import { t } from '../../../i18n/index.js';

/**
 * Scrollback summary for a single terminal-state subagent run.
 *
 * Two-line structured layout (inspired by the user prompt's "task → result"
 * phrasing — not a 1:1 copy of any reference CLI):
 *
 *   ≡ Agent · researcher · investigate import order
 *     ✓ 5 tools · 12s · 2.4k tok
 *
 * Mirrors gemini-cli's `SubagentGroupDisplay.tsx:229-243` for status glyph
 * choices (✓ / ✗ / ℹ). For multi-agent batches see `SubagentGroupSummary`.
 */
export const SubagentSummary: React.FC<{
  data: AgentResultDisplay;
}> = ({ data }) => {
  const { glyph, color, label } = statusVisual(data.status);

  const stats = data.executionSummary;
  const statParts: string[] = [];
  if (stats?.totalToolCalls !== undefined) {
    statParts.push(
      t('ui.subagent.statsTools', { n: String(stats.totalToolCalls) }),
    );
  }
  if (stats?.totalDurationMs !== undefined) {
    statParts.push(
      formatDuration(stats.totalDurationMs, { hideTrailingZeros: true }),
    );
  }
  if (stats?.totalTokens && stats.totalTokens > 0) {
    statParts.push(
      t('ui.subagent.statsTokens', { k: formatTokenCount(stats.totalTokens) }),
    );
  }
  const statTail = statParts.length > 0 ? statParts.join(' · ') : '';

  const safeName = escapeAnsiCtrlCodes(
    data.subagentName ?? t('ui.subagent.singleAgent'),
  );
  const safeDescription = data.taskDescription
    ? escapeAnsiCtrlCodes(data.taskDescription)
    : '';
  const reason =
    data.status !== 'completed' && data.terminateReason
      ? ` · ${escapeAnsiCtrlCodes(data.terminateReason)}`
      : '';

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text wrap="truncate-end">
          <Text color={theme.text.accent}>{`${SUBAGENT_GROUP_GLYPH} `}</Text>
          <Text bold>{t('ui.subagent.singleAgent')}</Text>
          <Text color={theme.text.secondary}>
            {' · '}
            {safeName}
          </Text>
          {safeDescription ? (
            <Text color={theme.text.secondary}>
              {' · '}
              {safeDescription}
            </Text>
          ) : null}
        </Text>
      </Box>
      <Box paddingLeft={2}>
        <Text wrap="truncate-end">
          <Text color={color}>{`${glyph} `}</Text>
          <Text color={theme.text.secondary}>{label}</Text>
          {statTail ? (
            <Text color={theme.text.secondary}>
              {' · '}
              {statTail}
            </Text>
          ) : null}
          {reason ? <Text color={theme.text.secondary}>{reason}</Text> : null}
        </Text>
      </Box>
    </Box>
  );
};

function statusVisual(status: AgentResultDisplay['status']): {
  glyph: string;
  color: string;
  label: string;
} {
  switch (status) {
    case 'completed':
      return {
        glyph: SUBAGENT_GLYPH_COMPLETED,
        color: theme.status.success,
        label: t('ui.subagent.completedLine'),
      };
    case 'failed':
      return {
        glyph: SUBAGENT_GLYPH_FAILED,
        color: theme.status.error,
        label: t('ui.subagent.failedLine'),
      };
    case 'cancelled':
      return {
        glyph: SUBAGENT_GLYPH_CANCELLED,
        color: theme.status.warning,
        label: t('ui.subagent.cancelledLine'),
      };
    default:
      return {
        glyph: '·',
        color: theme.text.secondary,
        label: t('ui.subagent.runningLine'),
      };
  }
}
