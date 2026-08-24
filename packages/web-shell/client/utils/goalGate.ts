/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GoalLimitKind,
  GoalSnapshotV2,
  GoalStatus,
} from '@qwen-code/sdk/daemon';

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

/**
 * The two `lastReason` sentinels that marked an evidence-limited stop before
 * `limitKind` existed.
 *
 * Duplicated from `packages/core/src/goals/goal-protocol.ts` because the Web
 * Shell client bundles for the browser and does not depend on
 * `@qwen-code/qwen-code-core`. `goalGate.drift.test.ts` reads that file and
 * fails if either string moves, so this copy cannot go stale silently.
 */
export const GOAL_EVIDENCE_LIMIT_REASONS: readonly string[] = [
  'The current Goal revision exceeded the bounded evidence catalog. Automatic retries cannot recover. Edit or replace the Goal before resuming it.',
  'The current Goal revision exceeded the checkpoint verifier request limit. Automatic retries cannot recover. Edit or replace the Goal before resuming it.',
];

/** The slice of a Goal record the resume gate reads. */
export interface GoalResumeGateRecord {
  status: GoalStatus;
  lastReason?: string | undefined;
  limitKind?: GoalLimitKind | undefined;
}

/**
 * Whether a stopped Goal was stopped by one of the evidence bounds.
 *
 * Mirrors core's private `isEvidenceLimited` (`goal-reducer.ts`): `limitKind`
 * is the field of record, and the `lastReason` comparison behind it reads
 * Goals persisted before `limitKind` existed, where the sentinel prose was the
 * only marker a transition could key off.
 */
export function isGoalEvidenceLimited(goal: GoalResumeGateRecord): boolean {
  return (
    goal.limitKind !== undefined ||
    (goal.lastReason !== undefined &&
      GOAL_EVIDENCE_LIMIT_REASONS.includes(goal.lastReason))
  );
}

/**
 * Whether `resume` is a transition the reducer will accept for this Goal.
 *
 * Stated as the reducer states it (`reduceGoalControl`), not as an
 * approximation of it: every Goal resume affordance in the client goes through
 * here, so an offered Resume button cannot dead-end in an invalid-transition
 * 409 that the UI itself promised would not happen.
 */
export function canResumeGoal(goal: GoalResumeGateRecord): boolean {
  if (goal.status === 'complete' || goal.status === 'active') return false;
  return true;
}
