/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GoalRecord,
  GoalSnapshotV2,
  GoalStateCause,
  GoalStateRecordPayloadV2,
} from './goal-protocol.js';

/**
 * The Goal card ACP clients render as history: the Web Shell shows one per
 * transition it admits, and a pre-#7895 transcript replays the cards it
 * recorded in this same shape. The wire key is `_meta.goalStatus`; the live
 * Goal is never derived from it (clients read `_meta.goalState`).
 */
export type GoalCardKind =
  | 'set'
  | 'achieved'
  | 'cleared'
  | 'failed'
  | 'aborted'
  | 'paused'
  | 'checking';

export interface GoalCard {
  kind: GoalCardKind;
  condition: string;
  iterations?: number;
  setAt?: number;
  durationMs?: number;
  lastReason?: string;
}

/**
 * The card for one `goal_state` transition. `previousGoal` names the Goal a
 * `clear` transition cleared, since its snapshot holds no Goal: a replay
 * passes the Goal from the record before, a live session the one it last
 * published.
 */
export function projectGoalCard(
  payload: GoalStateRecordPayloadV2,
  previousGoal: GoalRecord | null = null,
): GoalCard {
  const displayGoal = payload.snapshot.goal ?? previousGoal;
  return {
    kind: cardKind(payload),
    condition: displayGoal?.objective ?? '',
    ...(displayGoal ? { iterations: displayGoal.turnCount } : {}),
    ...(displayGoal ? { setAt: displayGoal.createdAt } : {}),
    ...(displayGoal ? { durationMs: displayGoal.activeTimeMs } : {}),
    ...(displayGoal?.lastReason === undefined
      ? {}
      : { lastReason: displayGoal.lastReason }),
  };
}

// Checkpoint bookkeeping records differ from their predecessor only in
// evidence bookkeeping fields, so display paths suppress them as duplicates.
function isGoalCheckpointBookkeepingTransition(
  previous: GoalSnapshotV2 | undefined,
  next: GoalSnapshotV2,
): boolean {
  const previousGoal = previous?.goal;
  const nextGoal = next.goal;
  if (!previousGoal || !nextGoal) return false;
  return (
    previousGoal.goalId === nextGoal.goalId &&
    previousGoal.revision === nextGoal.revision &&
    previousGoal.objective === nextGoal.objective &&
    previousGoal.status === nextGoal.status &&
    previousGoal.turnCount === nextGoal.turnCount &&
    previousGoal.createdAt === nextGoal.createdAt &&
    previousGoal.lastReason === nextGoal.lastReason
  );
}

// A shape-equal transition is bookkeeping only when its cause is a
// checkpoint follow-up write; a verifier rejection that repeats the
// preceding turn's snapshot is a genuine rejection card.
function isGoalCheckpointBookkeepingCause(
  cause: GoalStateCause,
  previousCause: GoalStateCause | undefined,
): boolean {
  if (cause === 'checkpoint') return true;
  return (
    cause === 'verifier_reject' &&
    (previousCause === 'verifier_reject' || previousCause === 'checkpoint')
  );
}

// The one suppression predicate the replay and resume display paths share:
// the record is a checkpoint bookkeeping rewrite of the snapshot the
// previous goal_state record already carried.
export function isGoalCheckpointBookkeepingRecord(input: {
  cause: GoalStateCause;
  previousCause: GoalStateCause | undefined;
  previous: GoalSnapshotV2 | undefined;
  next: GoalSnapshotV2;
}): boolean {
  return (
    isGoalCheckpointBookkeepingTransition(input.previous, input.next) &&
    isGoalCheckpointBookkeepingCause(input.cause, input.previousCause)
  );
}

function cardKind(payload: GoalStateRecordPayloadV2): GoalCardKind {
  switch (payload.cause) {
    case 'create':
    case 'replace':
    case 'edit':
    case 'resume':
      return 'set';
    case 'complete':
      return 'achieved';
    case 'clear':
      return 'cleared';
    // `migrated` is what builds between #7895 and #12155 wrote when they
    // lifted a pre-#7895 card into state: always a paused Goal, which
    // nothing drives, so it shows as one.
    case 'migrated':
    case 'pause':
      return 'paused';
    case 'blocked':
    case 'usage_limited':
      return 'aborted';
    case 'turn_finished':
    case 'checkpoint':
    case 'verifier_accept':
    case 'verifier_reject':
      return payload.snapshot.goal?.status === 'complete'
        ? 'achieved'
        : payload.snapshot.goal?.status === 'blocked' ||
            payload.snapshot.goal?.status === 'usage_limited'
          ? 'aborted'
          : 'checking';
    default:
      return assertNever(payload.cause);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Goal state cause: ${String(value)}`);
}
