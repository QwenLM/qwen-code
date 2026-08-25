/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GoalControlRequest, GoalRecord } from '@qwen-code/sdk/daemon';

export type GoalControlAction =
  | 'create'
  | 'replace'
  | 'edit'
  | 'pause'
  | 'resume'
  | 'clear';

/**
 * Build the versioned control request for `action` against the goal the daemon
 * just reported.
 *
 * Shared by the main composer and the split-view pane: both read a fresh
 * snapshot, then stamp `expectedGoalId`/`expectedRevision` from it. Keeping the
 * construction in one place is what stops the two surfaces from drifting apart
 * on the optimistic-concurrency contract.
 */
export function buildGoalControlRequest(
  action: GoalControlAction,
  goal: GoalRecord | null | undefined,
  objective: string | undefined,
  errors: { emptyObjective: string; goalUnavailable: string },
): GoalControlRequest {
  if (action === 'create' || action === 'replace') {
    if (!objective) throw new Error(errors.emptyObjective);
    // Replacing nothing is a create; the daemon rejects a replace that names a
    // goal it no longer holds.
    return goal
      ? {
          action: 'replace',
          objective,
          expectedGoalId: goal.goalId,
          expectedRevision: goal.revision,
        }
      : { action: 'create', objective };
  }
  if (!goal) throw new Error(errors.goalUnavailable);
  return {
    action,
    ...(action === 'edit' ? { objective: objective ?? goal.objective } : {}),
    expectedGoalId: goal.goalId,
    expectedRevision: goal.revision,
  } as GoalControlRequest;
}
