/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { formatDuration } from '../../utils/formatters.js';
import type { GoalStatusKind } from '../../types.js';

interface GoalStatusMessageProps {
  kind: GoalStatusKind;
  condition: string;
  iterations?: number;
  durationMs?: number;
  lastReason?: string;
}

const pluralTurns = (n: number) => (n === 1 ? 'turn' : 'turns');

export const GoalStatusMessage: React.FC<GoalStatusMessageProps> = ({
  kind,
  condition,
  iterations,
  durationMs,
  lastReason,
}) => {
  // The "checking" kind is the per-iteration "judge said not met, continuing"
  // marker that replaces the generic `stop_hook_loop` rendering for /goal.
  // Slim one-liner with a hollow circle to signal "pending" without the
  // alarming `Stop hook error:` framing. The judge's reason is intentionally
  // NOT shown here — it would clutter the per-turn chip and the same reason
  // surfaces as the model's next user prompt anyway. The eventual "Last
  // check: …" line appears once in the final achieved/aborted card.
  if (kind === 'checking') {
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={theme.text.secondary}>○</Text>
        </Box>
        <Box flexGrow={1}>
          <Text color={theme.text.secondary}>
            Goal check
            {typeof iterations === 'number' && iterations > 0
              ? ` · turn ${iterations}`
              : ''}{' '}
            · not yet met
          </Text>
        </Box>
      </Box>
    );
  }

  const { prefix, prefixColor, title } = (() => {
    switch (kind) {
      case 'set':
        // ◎ matches the footer GoalPill's icon — same visual identity for
        // "goal is on / armed" between the history card and the live pill.
        return {
          prefix: '◎',
          prefixColor: theme.text.accent,
          title: 'Goal set',
        };
      case 'achieved':
        return {
          prefix: '✓',
          prefixColor: theme.status.success,
          title: 'Goal achieved',
        };
      case 'cleared':
        return {
          prefix: '○',
          prefixColor: theme.text.secondary,
          title: 'Goal cleared',
        };
      case 'aborted':
      default:
        return {
          prefix: '!',
          prefixColor: theme.status.warning,
          title: 'Goal aborted',
        };
    }
  })();

  const stats: string[] = [];
  if (typeof iterations === 'number' && iterations > 0) {
    stats.push(`${iterations} ${pluralTurns(iterations)}`);
  }
  if (typeof durationMs === 'number') {
    stats.push(formatDuration(durationMs, { hideTrailingZeros: true }));
  }
  const subtitle = stats.length > 0 ? stats.join(' · ') : null;

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={prefixColor}>{prefix}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text color={prefixColor}>
          {title}
          {subtitle ? (
            <Text color={theme.text.secondary}> · {subtitle}</Text>
          ) : null}
        </Text>
        {/* Ink's flex-row layout strips trailing whitespace inside the label
            Text (so "Last check: " renders as "Last check:" with the value
            slammed up against the colon, and wrapped lines align with col 0
            of the value instead of after the colon-space). Use marginRight
            on the label Box to introduce a real 1-column gap that survives
            the row layout — same fix applies to the "Goal:" row. */}
        <Box flexDirection="row">
          <Box flexShrink={0} marginRight={1}>
            <Text color={theme.text.secondary}>Goal:</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="wrap">{condition}</Text>
          </Box>
        </Box>
        {/* `lastReason` is shown on terminal cards (achieved / aborted) so
            the final summary records *why* the judge ruled the goal complete
            or why the loop gave up. Skipped for `cleared` because user-driven
            clears don't carry a judge reason.
            Rendered as a single `<Text wrap="wrap">` (label + value inline)
            rather than the flex-row split used for `Goal:` above — the judge
            reason is capped at 240 chars and almost always wraps, and the
            flex-row variant hangs the continuation at the value column's
            left edge (≈12 cols of empty space, easily mistaken for a blank
            line). One Text + natural wrap keeps the continuation flush. */}
        {(kind === 'achieved' || kind === 'aborted') && lastReason?.trim() ? (
          <Text color={theme.text.secondary} wrap="wrap">
            Last check: {lastReason.trim()}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};
