/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GoalSnapshotV2, GoalStateCause } from '../goals/goal-protocol.js';
import { elapsedActiveTime } from '../goals/goal-reducer.js';
import {
  GOAL_STATE_EVENT_CAUSES,
  makeGoalStateEvent,
  type GoalStateEvent,
  type GoalStateEventCause,
} from './types.js';

const REPORTED_CAUSES: ReadonlySet<GoalStateCause> = new Set(
  GOAL_STATE_EVENT_CAUSES,
);

export function isGoalStateEventCause(
  cause: GoalStateCause | undefined,
): cause is GoalStateEventCause {
  return cause !== undefined && REPORTED_CAUSES.has(cause);
}

/**
 * The telemetry event for one Goal runtime broadcast, or undefined when the
 * broadcast is not a transition worth reporting.
 *
 * Reads the snapshot the broadcast carried. A `clear` leaves `goal` null and
 * names the Goal it removed in `clearedGoal`. An active Goal's committed
 * `activeTimeMs` lags the clock, so the figure is read as of `now`.
 */
export function goalStateEventFromSnapshot(
  snapshot: GoalSnapshotV2,
  cause: GoalStateCause | undefined,
  now: number = Date.now(),
): GoalStateEvent | undefined {
  if (!isGoalStateEventCause(cause)) return undefined;
  const goal = snapshot.goal;
  if (!goal) {
    const cleared = snapshot.clearedGoal;
    return cause === 'clear' && cleared
      ? makeGoalStateEvent({
          cause,
          goal_id: cleared.goalId,
          revision: cleared.revision,
        })
      : undefined;
  }
  return makeGoalStateEvent({
    cause,
    goal_id: goal.goalId,
    revision: goal.revision,
    status: goal.status,
    limit_kind: goal.limitKind,
    turn_count: goal.turnCount,
    tokens_used: goal.tokensUsed,
    token_budget: goal.tokenBudget,
    turn_budget: goal.turnBudget,
    active_time_ms: elapsedActiveTime(goal, now),
    active_time_budget_ms: goal.activeTimeBudgetMs,
    objective_length: [...goal.objective].length,
  });
}
