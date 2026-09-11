/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import {
  GOAL_CHECKPOINT_STALL_LIMIT,
  goalCheckpointHealthVisible,
  type GoalSnapshotV2,
  type GoalStateCause,
} from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { sanitizeTerminalText } from '../../utils/textUtils.js';
import { ICON } from '../../constants.js';
import { formatDuration } from '../../utils/formatters.js';
import { formatTokenCount } from '../../statusLinePresets.js';
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
          <Text color={theme.text.secondary}>{ICON.CIRCLE_EMPTY}</Text>
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
            prefix: ICON.CIRCLE_EMPTY,
            color: theme.text.secondary,
            title: 'Goal checking',
          };
        }
        return {
          prefix: ICON.BULLSEYE,
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
          prefix: ICON.CROSS,
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
          prefix: ICON.CHECK,
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
  if (goal.tokensUsed > 0) {
    const used = formatTokenCount(goal.tokensUsed);
    stats.push(
      goal.tokenBudget === undefined
        ? `${used} tokens`
        : `${used}/${formatTokenCount(goal.tokenBudget)} tokens`,
    );
  }
  const subtitle = stats.length > 0 ? stats.join(' · ') : null;
  const reason =
    goal.status !== 'active' || snapshot.activity === 'verifying'
      ? goal.lastReason?.trim()
      : undefined;
  // Checkpoint health, shown before the stall breaker has to stop the Goal:
  // a Goal paying a failed checkpoint every turn otherwise looks like one
  // that is working. A Goal the breaker stopped keeps the line, since its stop
  // reason names the kind of failure but not the failure itself; which
  // records show it at all is decided once, in goalCheckpointHealthVisible.
  // The diagnostic is cleaned where it is written and again here, because
  // this renderer writes straight to the terminal.
  const stalls = goal.checkpointStalls ?? 0;
  const checkpointFailure = sanitizeTerminalText(
    goal.lastCheckpointFailure ?? '',
  ).trim();
  const checkpoint = goalCheckpointHealthVisible(goal)
    ? [
        stalls > 0
          ? `${stalls}/${GOAL_CHECKPOINT_STALL_LIMIT} stalled`
          : 'last check failed',
        checkpointFailure,
      ]
        .filter(Boolean)
        .join(' · ')
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
        {checkpoint ? (
          <Text color={theme.status.warning} wrap="wrap">
            Checkpoint: {checkpoint}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};

const GoalStatusMessageInternal: React.FC<GoalStatusMessageProps> = (props) => {
  if (props.snapshot) return <GoalStateCard {...props} />;
  const { kind, condition, iterations, durationMs, lastReason } = props;
  if (kind === 'checking') {
    const reason = lastReason?.trim();
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={theme.text.secondary}>{ICON.CIRCLE_EMPTY}</Text>
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
        return {
          prefix: ICON.BULLSEYE,
          prefixColor: theme.text.accent,
          title: 'Goal set',
        };
      case 'achieved':
        return {
          prefix: ICON.CHECK,
          prefixColor: theme.status.success,
          title: 'Goal achieved',
        };
      case 'cleared':
        return {
          prefix: ICON.CIRCLE_EMPTY,
          prefixColor: theme.text.secondary,
          title: 'Goal cleared',
        };
      case 'failed':
        return {
          prefix: ICON.CROSS,
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
        <Box flexDirection="row">
          <Box flexShrink={0} marginRight={1}>
            <Text color={theme.text.secondary}>Goal:</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="wrap">{condition}</Text>
          </Box>
        </Box>
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
