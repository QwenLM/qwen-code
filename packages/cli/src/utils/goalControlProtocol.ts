/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Helpers shared by the SDK goal control requests
 * (`set_goal` / `get_goal` / `clear_goal`) in headless sessions.
 */

import { randomUUID } from 'node:crypto';
import {
  SDK_GOAL_STATUSES,
  GoalStatus,
  coreEvents,
  CoreEvent,
  type Goal,
  type GoalClearedPayload,
  type GoalUpdatedPayload,
  type SDKGoalSnapshot,
  type SDKGoalStatus,
  type Config,
} from '@qwen-code/core';

/** Type guard for the wire goal status enum. */
export function isSdkGoalStatus(value: unknown): value is SDKGoalStatus {
  return (
    typeof value === 'string' &&
    (SDK_GOAL_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Compile-time-checked mapping from the internal enum to the wire union —
 * keeps the two in lockstep without casts (Record exhaustiveness).
 */
const GOAL_STATUS_TO_WIRE: Record<GoalStatus, SDKGoalStatus> = {
  [GoalStatus.Active]: 'active',
  [GoalStatus.Paused]: 'paused',
  [GoalStatus.Blocked]: 'blocked',
  [GoalStatus.UsageLimited]: 'usage_limited',
  [GoalStatus.BudgetLimited]: 'budget_limited',
  [GoalStatus.Complete]: 'complete',
};

/**
 * Compile-time-checked reverse of GOAL_STATUS_TO_WIRE: wire status → internal
 * enum. Used by the set_goal handler after `isSdkGoalStatus` validates the
 * value, so the cast is gone from the call site.
 */
export function toGoalStatus(status: SDKGoalStatus): GoalStatus {
  switch (status) {
    case 'active':
      return GoalStatus.Active;
    case 'paused':
      return GoalStatus.Paused;
    case 'blocked':
      return GoalStatus.Blocked;
    case 'usage_limited':
      return GoalStatus.UsageLimited;
    case 'budget_limited':
      return GoalStatus.BudgetLimited;
    case 'complete':
      return GoalStatus.Complete;
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

/** Serialize the internal Goal record into the wire snapshot shape. */
export function buildGoalSnapshot(goal: Goal): SDKGoalSnapshot {
  const snapshot: SDKGoalSnapshot = {
    id: goal.id,
    objective: goal.objective,
    status: GOAL_STATUS_TO_WIRE[goal.status],
    turns_used: goal.turnsUsed,
    time_used_seconds: goal.timeUsedSeconds,
    created_at: goal.createdAt,
    updated_at: goal.updatedAt,
  };
  if (goal.maxTurns !== undefined) snapshot.max_turns = goal.maxTurns;
  if (goal.creditsBudget !== undefined)
    snapshot.credits_budget = goal.creditsBudget;
  if (goal.creditsUsed !== undefined) snapshot.credits_used = goal.creditsUsed;
  return snapshot;
}

/**
 * Install the goal lifecycle event bridge for SDK stream-json sessions.
 * Writes goal_updated / goal_cleared system messages to the NDJSON stream
 * and returns an unsubscribe function for cleanup.
 */
export function installGoalEventBridge(deps: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeNdjson: (msg: any) => void;
  config: Config;
}): () => void {
  const onUpdated = (payload: GoalUpdatedPayload): void => {
    const goal = deps.config.getGoalManager().getGoal();
    if (!goal) return;
    deps.writeNdjson({
      type: 'system',
      subtype: 'goal_updated',
      goal: buildGoalSnapshot(goal),
      ...(payload.reason ? { reason: payload.reason } : {}),
      uuid: randomUUID(),
      session_id: deps.config.getSessionId(),
    });
  };
  const onCleared = (payload: GoalClearedPayload): void => {
    deps.writeNdjson({
      type: 'system',
      subtype: 'goal_cleared',
      goal_id: payload.goalId,
      ...(payload.reason ? { reason: payload.reason } : {}),
      uuid: randomUUID(),
      session_id: deps.config.getSessionId(),
    });
  };
  coreEvents.on(CoreEvent.GoalUpdated, onUpdated);
  coreEvents.on(CoreEvent.GoalCleared, onCleared);
  return () => {
    coreEvents.off(CoreEvent.GoalUpdated, onUpdated);
    coreEvents.off(CoreEvent.GoalCleared, onCleared);
  };
}
