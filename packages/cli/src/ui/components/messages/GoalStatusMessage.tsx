/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import type { GoalStatusKind } from '../../types.js';

interface GoalStatusMessageProps {
  kind: GoalStatusKind;
  condition: string;
  iterations?: number;
  durationMs?: number;
  lastReason?: string;
}

const pluralTurns = (n: number) => (n === 1 ? 'turn' : 'turns');

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export const GoalStatusMessage: React.FC<GoalStatusMessageProps> = ({
  kind,
  condition,
  iterations,
  durationMs,
  // `lastReason` is accepted on the props interface so callers (history
  // factory, observer, restore) can pass it without conditionals, but it is
  // intentionally NOT rendered — checking shows a slim status line and the
  // terminal cards drop "Last check:" to stay compact.
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
    stats.push(formatDuration(durationMs));
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
        {/* `lastReason` is intentionally NOT rendered in achieved / cleared /
            aborted cards. The judge's verbose reason is more useful inline
            during the loop (as the model's continuation prompt) than as a
            persistent footer on the final summary — and the achieved card is
            usually long enough to wrap awkwardly when the reason is also
            shown. */}
      </Box>
    </Box>
  );
};
