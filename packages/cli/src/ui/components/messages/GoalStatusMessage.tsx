/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { GoalSnapshotV2, GoalStateCause } from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { formatDuration } from '../../utils/formatters.js';
import { isTerminalGoalStatusKind, type GoalStatusKind } from '../../types.js';

interface LegacyGoalStatusMessageProps {
  kind: GoalStatusKind;
  condition: string;
  iterations?: number;
  durationMs?: number;
  lastReason?: string;
  snapshot?: never;
  cause?: never;
}

interface GoalStateMessageProps {
  snapshot: GoalSnapshotV2;
  cause?: GoalStateCause;
  kind?: never;
  condition?: never;
  iterations?: never;
  durationMs?: never;
  lastReason?: never;
}

type GoalStatusMessageProps =
  | LegacyGoalStatusMessageProps
  | GoalStateMessageProps;

const pluralTurns = (n: number) => (n === 1 ? 'turn' : 'turns');

function assertNeverGoalStatusKind(kind: never): never {
  throw new Error(`Unexpected goal status kind: ${kind}`);
}

const GoalStateCard: React.FC<GoalStateMessageProps> = ({
  snapshot,
  cause,
}) => {
  const goal = snapshot.goal;
  if (!goal) {
    if (cause !== 'clear') return null;
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={theme.text.secondary}>○</Text>
        </Box>
        <Text color={theme.text.secondary}>Goal cleared</Text>
      </Box>
    );
  }

  const lifecycle = (() => {
    switch (goal.status) {
      case 'active':
        if (snapshot.activity === 'verifying') {
          return {
            prefix: '○',
            color: theme.text.secondary,
            title: 'Goal checking',
          };
        }
        return {
          prefix: '◎',
          color: theme.text.accent,
          title:
            snapshot.activity === 'running' ? 'Goal running' : 'Goal active',
        };
      case 'paused':
        return {
          prefix: '!',
          color: theme.status.warning,
          title: 'Goal paused',
        };
      case 'blocked':
        return {
          prefix: '✖',
          color: theme.status.error,
          title: 'Goal blocked',
        };
      case 'usage_limited':
        return {
          prefix: '!',
          color: theme.status.warning,
          title: 'Goal usage limited',
        };
      case 'complete':
        return {
          prefix: '✓',
          color: theme.status.success,
          title: 'Goal complete',
        };
      default: {
        const exhaustive: never = goal.status;
        void exhaustive;
        throw new Error('Unexpected Goal status');
      }
    }
  })();
  const stats: string[] = [];
  if (goal.turnCount > 0) {
    stats.push(`${goal.turnCount} ${pluralTurns(goal.turnCount)}`);
  }
  if (goal.activeTimeMs > 0) {
    stats.push(formatDuration(goal.activeTimeMs, { hideTrailingZeros: true }));
  }
  const subtitle = stats.length > 0 ? stats.join(' · ') : null;
  const reason =
    goal.status !== 'active' || snapshot.activity === 'verifying'
      ? goal.lastReason?.trim()
      : undefined;

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={lifecycle.color}>{lifecycle.prefix}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text color={lifecycle.color}>
          {lifecycle.title}
          {subtitle ? (
            <Text color={theme.text.secondary}> · {subtitle}</Text>
          ) : null}
        </Text>
        <Box flexDirection="row">
          <Box flexShrink={0} marginRight={1}>
            <Text color={theme.text.secondary}>Goal:</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="wrap">{goal.objective}</Text>
          </Box>
        </Box>
        {reason ? (
          <Text color={theme.text.secondary} wrap="wrap">
            Reason: {reason}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};

const GoalStatusMessageInternal: React.FC<GoalStatusMessageProps> = (props) => {
  if (props.snapshot) return <GoalStateCard {...props} />;
  const { kind, condition, iterations, durationMs, lastReason } = props;
  // The "checking" kind is the per-iteration "judge said not met, continuing"
  // marker that replaces the generic `stop_hook_loop` rendering for /goal.
  // Show the active condition and latest judge reason on every iteration so
  // the user can see why the loop is continuing.
  if (kind === 'checking') {
    const reason = lastReason?.trim();
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={theme.text.secondary}>○</Text>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          <Text color={theme.text.secondary}>
            Goal check
            {typeof iterations === 'number' && iterations > 0
              ? ` · turn ${iterations}`
              : ''}{' '}
            · not yet met
          </Text>
          <Text color={theme.text.secondary} wrap="wrap">
            Goal: {condition}
          </Text>
          {reason ? (
            <Text color={theme.text.secondary} wrap="wrap">
              Judge: {reason}
            </Text>
          ) : null}
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
      case 'failed':
        return {
          prefix: '✖',
          prefixColor: theme.status.error,
          title: 'Goal could not be achieved',
        };
      case 'aborted':
        return {
          prefix: '!',
          prefixColor: theme.status.warning,
          title: 'Goal aborted',
        };
      case 'paused':
        return {
          prefix: '!',
          prefixColor: theme.status.warning,
          title: 'Goal paused',
        };
      default:
        return assertNeverGoalStatusKind(kind);
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
        {/* `lastReason` is shown on terminal cards (achieved / aborted /
            failed) so
            the final summary records *why* the judge ruled the goal complete
            or why the loop gave up. Skipped for `cleared` because user-driven
            clears don't carry a judge reason.
            Rendered as a single `<Text wrap="wrap">` (label + value inline)
            rather than the flex-row split used for `Goal:` above — the judge
            reason is capped at 240 chars and almost always wraps, and the
            flex-row variant hangs the continuation at the value column's
            left edge (≈12 cols of empty space, easily mistaken for a blank
            line). One Text + natural wrap keeps the continuation flush. */}
        {isTerminalGoalStatusKind(kind) && lastReason?.trim() ? (
          <Text color={theme.text.secondary} wrap="wrap">
            Last check: {lastReason.trim()}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};

export const GoalStatusMessage = React.memo(GoalStatusMessageInternal);
