/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Render-ready views of the two Goal cards: the v2 `goal_state` card and the
 * legacy `goal_status` one. Pure, so every lifecycle state is unit-testable,
 * and shared, so the ink and OpenTUI renderers cannot word the same record
 * differently. Text is returned as recorded; a renderer that writes to a
 * terminal sanitizes it.
 */

import { goalCheckpointHealthLine } from '@qwen-code/qwen-code-core/goals/goal-protocol.js';
import { ICON } from '../constants.js';
import { formatTokenCount } from '../statusLinePresets.js';
import { formatDuration } from './formatters.js';

/** Loose GoalSnapshotV2 shape (goal-protocol.ts) for display purposes. */
export type GoalSnapshotLike = {
  goal?: {
    objective?: string;
    status?: string;
    turnCount?: number;
    turnBudget?: number;
    activeTimeMs?: number;
    activeTimeBudgetMs?: number;
    tokensUsed?: number;
    tokenBudget?: number;
    checkpointStalls?: number;
    lastCheckpointFailure?: string;
    lastReason?: string;
  } | null;
  activity?: string;
};

/** The fields of a legacy `goal_status` history item a card is drawn from. */
export type GoalLegacyCardData = {
  kind: string;
  condition: string;
  iterations?: number;
  durationMs?: number;
  lastReason?: string;
};

/** Semantic palette slot of a goal card; the backend maps it to theme colors. */
export type GoalCardColor =
  | 'secondary'
  | 'accent'
  | 'warning'
  | 'error'
  | 'success';

/** Render-ready view of a v2 goal_state card (ink GoalStateCard). */
export type GoalCardView =
  | { state: 'hidden' }
  | { state: 'cleared' }
  | {
      state: 'card';
      icon: string;
      color: GoalCardColor;
      title: string;
      subtitle: string | null;
      objective: string;
      reason?: string;
      /** Checkpoint health, when goalCheckpointHealthVisible shows it. */
      checkpoint?: string;
    };

/** Computes the GoalStateCard view (icon/title/subtitle/objective/reason)
 * from a v2 snapshot, pure so every lifecycle state is unit-testable. */
export function describeGoalCard(
  snapshot: GoalSnapshotLike | undefined,
  cause?: string,
): GoalCardView {
  const goal = snapshot?.goal ?? null;
  if (!goal) {
    return cause === 'clear' ? { state: 'cleared' } : { state: 'hidden' };
  }
  const activity = snapshot?.activity;
  let lifecycle: {
    icon: string;
    color: GoalCardColor;
    title: string;
  } | null;
  switch (goal.status ?? 'active') {
    case 'active':
      if (activity === 'verifying') {
        lifecycle = {
          icon: ICON.CIRCLE_EMPTY,
          color: 'secondary',
          title: 'Goal checking',
        };
      } else {
        lifecycle = {
          icon: ICON.BULLSEYE,
          color: 'accent',
          title: activity === 'running' ? 'Goal running' : 'Goal active',
        };
      }
      break;
    case 'paused':
      lifecycle = { icon: '!', color: 'warning', title: 'Goal paused' };
      break;
    case 'blocked':
      lifecycle = { icon: ICON.CROSS, color: 'error', title: 'Goal blocked' };
      break;
    case 'usage_limited':
      lifecycle = { icon: '!', color: 'warning', title: 'Goal usage limited' };
      break;
    case 'complete':
      lifecycle = {
        icon: ICON.CHECK,
        color: 'success',
        title: 'Goal complete',
      };
      break;
    default:
      lifecycle = null;
  }
  if (!lifecycle) return { state: 'hidden' };
  const stats: string[] = [];
  const turnCount = goal.turnCount ?? 0;
  if (turnCount > 0) {
    const turns = goal.turnBudget ?? turnCount;
    stats.push(
      `${turnCount}${goal.turnBudget === undefined ? '' : `/${goal.turnBudget}`} ${turns === 1 ? 'turn' : 'turns'}`,
    );
  }
  const activeTimeMs = goal.activeTimeMs ?? 0;
  if (activeTimeMs > 0) {
    const used = formatDuration(activeTimeMs, { hideTrailingZeros: true });
    stats.push(
      goal.activeTimeBudgetMs === undefined
        ? used
        : `${used}/${formatDuration(goal.activeTimeBudgetMs, { hideTrailingZeros: true })}`,
    );
  }
  const tokensUsed = goal.tokensUsed ?? 0;
  if (tokensUsed > 0) {
    const used = formatTokenCount(tokensUsed);
    stats.push(
      goal.tokenBudget === undefined
        ? `${used} tokens`
        : `${used}/${formatTokenCount(goal.tokenBudget)} tokens`,
    );
  }
  const reason =
    (goal.status ?? 'active') !== 'active' || activity === 'verifying'
      ? goal.lastReason?.trim()
      : undefined;
  // Checkpoint health, worded by core like the ink card's; transcript-view
  // sanitizes the line when it renders it, so no cleaner is passed here.
  const checkpointLine = goalCheckpointHealthLine(goal);
  const checkpoint =
    checkpointLine === undefined ? undefined : `Checkpoint: ${checkpointLine}`;
  return {
    state: 'card',
    icon: lifecycle.icon,
    color: lifecycle.color,
    title: lifecycle.title,
    subtitle: stats.length > 0 ? stats.join(' · ') : null,
    objective: goal.objective ?? '',
    reason,
    ...(checkpoint ? { checkpoint } : {}),
  };
}

/** Render-ready view of a legacy goal_status card (ink kind form). */
export type LegacyGoalCardView =
  | {
      state: 'checking';
      title: string;
      condition: string;
      judgeReason?: string;
    }
  | {
      state: 'card';
      icon: string;
      color: GoalCardColor;
      title: string;
      subtitle: string | null;
      condition: string;
      lastCheck?: string;
    }
  | { state: 'hidden' };

/** Computes the legacy goal card view from a goal_status item's fields,
 * pure so every kind is unit-testable. */
export function describeLegacyGoalCard(
  legacy: GoalLegacyCardData,
): LegacyGoalCardView {
  const reason = legacy.lastReason?.trim();
  if (legacy.kind === 'checking') {
    return {
      state: 'checking',
      title: `Goal check${
        legacy.iterations && legacy.iterations > 0
          ? ` · turn ${legacy.iterations}`
          : ''
      } · not yet met`,
      condition: legacy.condition,
      judgeReason: reason,
    };
  }
  const titleByKind: Record<
    string,
    { icon: string; color: GoalCardColor; title: string }
  > = {
    set: { icon: ICON.BULLSEYE, color: 'accent', title: 'Goal set' },
    achieved: { icon: ICON.CHECK, color: 'success', title: 'Goal achieved' },
    cleared: {
      icon: ICON.CIRCLE_EMPTY,
      color: 'secondary',
      title: 'Goal cleared',
    },
    failed: {
      icon: ICON.CROSS,
      color: 'error',
      title: 'Goal could not be achieved',
    },
    aborted: { icon: '!', color: 'warning', title: 'Goal aborted' },
    paused: { icon: '!', color: 'warning', title: 'Goal paused' },
  };
  const card = titleByKind[legacy.kind];
  if (!card) return { state: 'hidden' };
  const stats: string[] = [];
  if (legacy.iterations && legacy.iterations > 0) {
    stats.push(
      `${legacy.iterations} ${legacy.iterations === 1 ? 'turn' : 'turns'}`,
    );
  }
  if (typeof legacy.durationMs === 'number') {
    stats.push(formatDuration(legacy.durationMs, { hideTrailingZeros: true }));
  }
  const lastCheck =
    legacy.kind === 'achieved' ||
    legacy.kind === 'aborted' ||
    legacy.kind === 'failed'
      ? reason
      : undefined;
  return {
    state: 'card',
    icon: card.icon,
    color: card.color,
    title: card.title,
    subtitle: stats.length > 0 ? stats.join(' · ') : null,
    condition: legacy.condition,
    lastCheck,
  };
}
