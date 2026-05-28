/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import type { AgentResultDisplay } from '@qwen-code/qwen-code-core';

type AgentStatus = AgentResultDisplay['status'];
import { theme } from '../../semantic-colors.js';
import { escapeAnsiCtrlCodes } from '../../utils/textUtils.js';
import { formatDuration, formatTokenCount } from '../../utils/formatters.js';
import type { IndividualToolCallDisplay } from '../../types.js';
import {
  SUBAGENT_GROUP_GLYPH,
  SUBAGENT_GLYPH_COMPLETED,
  SUBAGENT_GLYPH_FAILED,
  SUBAGENT_GLYPH_CANCELLED,
  SUBAGENT_GLYPH_RUNNING,
} from '../../constants/subagentGlyphs.js';
import { t } from '../../../i18n/index.js';

/**
 * Scrollback summary for a batch of ≥2 sub-agents that ran in parallel.
 *
 *   ≡ 4 Agents (3 completed, 1 failed)
 *     ✓ researcher: investigate import order   · 5 tools · 12s · 2.4k tok
 *     ✓ planner:    sketch refactor            · 3 tools · 4s  · 0.8k tok
 *     ✓ writer:     update docs                · 2 tools · 2s  · 0.3k tok
 *     ✗ tester:     run regression             · 8 tools · 31s · timeout
 *
 * Header wording mirrors gemini-cli's `SubagentGroupDisplay.tsx:100-108`
 * — single line, count + state breakdown. We extend it with `failed`
 * because terminal-state batches commonly include failures and surfacing
 * them in the header avoids burying the signal in per-row glyphs.
 */
export const SubagentGroupSummary: React.FC<{
  subagentTools: IndividualToolCallDisplay[];
}> = ({ subagentTools }) => {
  const datas = subagentTools
    .map((t) => t.resultDisplay)
    .filter(
      (d): d is AgentResultDisplay =>
        typeof d === 'object' &&
        d !== null &&
        (d as { type?: string }).type === 'task_execution',
    );
  if (datas.length === 0) return null;

  const counts = {
    completed: 0,
    failed: 0,
    cancelled: 0,
    running: 0,
  };
  for (const d of datas) {
    switch (d.status as AgentStatus) {
      case 'completed':
        counts.completed++;
        break;
      case 'failed':
        counts.failed++;
        break;
      case 'cancelled':
        counts.cancelled++;
        break;
      case 'running':
      case 'background':
        counts.running++;
        break;
      default:
        break;
    }
  }

  const total = datas.length;
  const header = buildHeader(total, counts);

  return (
    <Box flexDirection="column" paddingLeft={1}>
      <Box>
        <Text wrap="truncate-end">
          <Text color={theme.text.accent}>{`${SUBAGENT_GROUP_GLYPH} `}</Text>
          <Text bold>{header}</Text>
        </Text>
      </Box>
      {datas.map((d, i) => (
        <SubagentGroupRow key={`${d.subagentName ?? 'agent'}-${i}`} data={d} />
      ))}
    </Box>
  );
};

type StateCounts = {
  completed: number;
  failed: number;
  cancelled: number;
  running: number;
};

function buildHeader(total: number, counts: StateCounts): string {
  // All in one terminal state → simpler wording.
  if (counts.running === 0 && counts.failed === 0 && counts.cancelled === 0) {
    return t('ui.subagent.groupCompleted', { n: String(total) });
  }
  if (counts.completed === 0 && counts.failed === 0 && counts.cancelled === 0) {
    return t('ui.subagent.groupRunning', { n: String(total) });
  }
  const parts: string[] = [];
  if (counts.running > 0) {
    parts.push(t('ui.subagent.stateRunning', { n: String(counts.running) }));
  }
  if (counts.completed > 0) {
    parts.push(
      t('ui.subagent.stateCompleted', { n: String(counts.completed) }),
    );
  }
  if (counts.failed > 0) {
    parts.push(t('ui.subagent.stateFailed', { n: String(counts.failed) }));
  }
  if (counts.cancelled > 0) {
    parts.push(
      t('ui.subagent.stateCancelled', { n: String(counts.cancelled) }),
    );
  }
  return t('ui.subagent.groupMixed', {
    n: String(total),
    states: parts.join(', '),
  });
}

const SubagentGroupRow: React.FC<{ data: AgentResultDisplay }> = ({ data }) => {
  const { glyph, color } = (() => {
    switch (data.status as AgentStatus) {
      case 'completed':
        return { glyph: SUBAGENT_GLYPH_COMPLETED, color: theme.status.success };
      case 'failed':
        return { glyph: SUBAGENT_GLYPH_FAILED, color: theme.status.error };
      case 'cancelled':
        return { glyph: SUBAGENT_GLYPH_CANCELLED, color: theme.status.warning };
      default:
        return { glyph: SUBAGENT_GLYPH_RUNNING, color: theme.text.primary };
    }
  })();

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
  const statTail = statParts.length > 0 ? ` · ${statParts.join(' · ')}` : '';
  const reason =
    data.status !== 'completed' && data.terminateReason
      ? ` · ${escapeAnsiCtrlCodes(data.terminateReason)}`
      : '';
  const safeName = data.subagentName
    ? `${escapeAnsiCtrlCodes(data.subagentName)}: `
    : '';
  const safeDescription = escapeAnsiCtrlCodes(data.taskDescription ?? '');

  return (
    <Box paddingLeft={2}>
      <Text wrap="truncate-end">
        <Text color={color}>{`${glyph} `}</Text>
        <Text bold>{safeName}</Text>
        <Text color={theme.text.secondary}>{safeDescription}</Text>
        <Text color={theme.text.secondary}>{statTail}</Text>
        <Text color={theme.text.secondary}>{reason}</Text>
      </Text>
    </Box>
  );
};
