/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GoalSnapshotV2, GoalStatus } from '@qwen-code/sdk/daemon';

/** The slice of the daemon connection the Goal gate reads. */
export interface GoalGateConnection {
  sessionId?: string | undefined;
  goalState?: GoalSnapshotV2 | undefined;
}

/**
 * Whether a local action must be held back because a Goal owns the session.
 *
 * Fails CLOSED while `goalState` is still hydrating: the session load clears
 * `loadingTranscript` (making the composer writable) before its `goal()` fetch
 * resolves, so an unknown Goal state on a real session has to read as "a Goal
 * may be active". Commands and automatic runs must not start against that
 * unknown ownership state.
 *
 * Command and automatic/manual run guards go through here. Ordinary chat
 * submissions are routed only by the session's streaming state.
 */
export function isGoalGateBlocked(connection: GoalGateConnection): boolean {
  return (
    connection.sessionId !== undefined &&
    (connection.goalState === undefined ||
      connection.goalState.goal?.status === 'active')
  );
}

/** The slice of a Goal record the resume gate reads. */
export interface GoalResumeGateRecord {
  status: GoalStatus;
}

/**
 * Whether `resume` is a transition the reducer will accept for this Goal.
 *
 * Stated as the reducer states it (`reduceGoalControl`), not as an
 * approximation of it: every Goal resume affordance in the client goes through
 * here, so an offered Resume button cannot dead-end in an invalid-transition
 * 409 that the UI itself promised would not happen. The reducer accepts resume
 * for every stopped status -- an evidence-limited Goal resumes by restarting
 * its evidence window -- so status is the whole contract.
 */
export function canResumeGoal(goal: GoalResumeGateRecord): boolean {
  if (goal.status === 'complete' || goal.status === 'active') return false;
  return true;
}
