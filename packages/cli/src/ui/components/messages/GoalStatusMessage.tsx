/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { GoalSnapshotV2, GoalStateCause } from '@qwen-code/qwen-code-core';
import { theme } from '../../semantic-colors.js';
import { sanitizeTerminalText } from '../../utils/textUtils.js';
import { ICON } from '../../constants.js';
import {
  describeGoalCard,
  describeLegacyGoalCard,
  type GoalCardColor,
} from '../../utils/goal-card-view.js';
import type { GoalStatusKind } from '../../types.js';

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

/** The theme colour of each palette slot a card view names. */
function cardColor(color: GoalCardColor): string {
  switch (color) {
    case 'secondary':
      return theme.text.secondary;
    case 'accent':
      return theme.text.accent;
    case 'warning':
      return theme.status.warning;
    case 'error':
      return theme.status.error;
    case 'success':
      return theme.status.success;
    default: {
      const exhaustive: never = color;
      throw new Error(`Unexpected goal card colour: ${String(exhaustive)}`);
    }
  }
}

const GoalStateCard: React.FC<GoalStateMessageProps> = ({
  snapshot,
  cause,
}) => {
  const view = describeGoalCard(snapshot, cause);
  if (view.state === 'hidden') {
    // A Goal is on the record but its status is one this build cannot word.
    if (snapshot.goal) throw new Error('Unexpected Goal status');
    return null;
  }
  if (view.state === 'cleared') {
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={theme.text.secondary}>{ICON.CIRCLE_EMPTY}</Text>
        </Box>
        <Text color={theme.text.secondary}>Goal cleared</Text>
      </Box>
    );
  }
  const color = cardColor(view.color);
  // This renderer writes straight to the terminal, so both lines below are
  // sanitized here: a pause reason can embed a raw provider error, and the
  // checkpoint diagnostic, though cleaned where it is written, can come back
  // from a journal record verbatim.
  const reason =
    view.reason === undefined
      ? undefined
      : sanitizeTerminalText(view.reason).trim();
  const checkpoint =
    view.checkpoint === undefined
      ? undefined
      : sanitizeTerminalText(view.checkpoint);

  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={color}>{view.icon}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text color={color}>
          {view.title}
          {view.subtitle ? (
            <Text color={theme.text.secondary}> · {view.subtitle}</Text>
          ) : null}
        </Text>
        <Box flexDirection="row">
          <Box flexShrink={0} marginRight={1}>
            <Text color={theme.text.secondary}>Goal:</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="wrap">{view.objective}</Text>
          </Box>
        </Box>
        {reason ? (
          <Text color={theme.text.secondary} wrap="wrap">
            Reason: {reason}
          </Text>
        ) : null}
        {checkpoint ? (
          <Text color={theme.status.warning} wrap="wrap">
            {checkpoint}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};

const GoalStatusMessageInternal: React.FC<GoalStatusMessageProps> = (props) => {
  if (props.snapshot) return <GoalStateCard {...props} />;
  const { kind, condition, iterations, durationMs, lastReason } = props;
  const view = describeLegacyGoalCard({
    kind,
    condition,
    iterations,
    durationMs,
    lastReason,
  });
  if (view.state === 'hidden') {
    throw new Error(`Unexpected goal status kind: ${kind}`);
  }
  if (view.state === 'checking') {
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={theme.text.secondary}>{ICON.CIRCLE_EMPTY}</Text>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          <Text color={theme.text.secondary}>{view.title}</Text>
          <Text color={theme.text.secondary} wrap="wrap">
            Goal: {view.condition}
          </Text>
          {view.judgeReason ? (
            <Text color={theme.text.secondary} wrap="wrap">
              Judge: {view.judgeReason}
            </Text>
          ) : null}
        </Box>
      </Box>
    );
  }

  const color = cardColor(view.color);
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text color={color}>{view.icon}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        <Text color={color}>
          {view.title}
          {view.subtitle ? (
            <Text color={theme.text.secondary}> · {view.subtitle}</Text>
          ) : null}
        </Text>
        <Box flexDirection="row">
          <Box flexShrink={0} marginRight={1}>
            <Text color={theme.text.secondary}>Goal:</Text>
          </Box>
          <Box flexGrow={1}>
            <Text wrap="wrap">{view.condition}</Text>
          </Box>
        </Box>
        {view.lastCheck ? (
          <Text color={theme.text.secondary} wrap="wrap">
            Last check: {view.lastCheck}
          </Text>
        ) : null}
      </Box>
    </Box>
  );
};

export const GoalStatusMessage = React.memo(GoalStatusMessageInternal);
