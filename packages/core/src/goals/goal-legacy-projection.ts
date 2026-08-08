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

export type LegacyGoalStatusKind =
  | 'set'
  | 'achieved'
  | 'cleared'
  | 'failed'
  | 'aborted'
  | 'paused'
  | 'checking';

export interface LegacyGoalStatus {
  type: 'goal_status';
  kind: LegacyGoalStatusKind;
  condition: string;
  iterations?: number;
  setAt?: number;
  durationMs?: number;
  lastReason?: string;
}

export interface LegacyActiveGoal {
  readonly condition: string;
  readonly iterations: number;
  readonly setAt: number;
  readonly tokensAtStart?: number;
  readonly hookId?: string;
  readonly lastReason?: string;
}

export interface LegacyGoalTerminal {
  kind: 'achieved' | 'failed' | 'aborted';
  condition: string;
  iterations: number;
  durationMs: number;
  lastReason?: string;
}

export interface LegacyGoalProjection {
  activeGoal: LegacyActiveGoal | null;
  goalStatus: LegacyGoalStatus;
  goalTerminal: LegacyGoalTerminal | null;
}

export function projectGoalStateToLegacy(
  payload: GoalStateRecordPayloadV2,
  previousGoal: GoalRecord | null = null,
): LegacyGoalProjection {
  const snapshotGoal = payload.snapshot.goal;
  const displayGoal = snapshotGoal ?? previousGoal;
  const kind = legacyStatusKind(payload);
  const goalStatus: LegacyGoalStatus = {
    type: 'goal_status',
    kind,
    condition: displayGoal?.objective ?? '',
    ...(displayGoal ? { iterations: displayGoal.turnCount } : {}),
    ...(displayGoal ? { setAt: displayGoal.createdAt } : {}),
    ...(displayGoal ? { durationMs: displayGoal.activeTimeMs } : {}),
    ...(displayGoal?.lastReason === undefined
      ? {}
      : { lastReason: displayGoal.lastReason }),
  };
  const terminalKind =
    kind === 'achieved' || kind === 'failed' || kind === 'aborted'
      ? kind
      : undefined;

  return {
    activeGoal:
      snapshotGoal?.status === 'active'
        ? {
            condition: snapshotGoal.objective,
            iterations: snapshotGoal.turnCount,
            setAt: snapshotGoal.createdAt,
            ...(snapshotGoal.lastReason === undefined
              ? {}
              : { lastReason: snapshotGoal.lastReason }),
          }
        : null,
    goalStatus,
    goalTerminal:
      terminalKind && displayGoal
        ? {
            kind: terminalKind,
            condition: displayGoal.objective,
            iterations: displayGoal.turnCount,
            durationMs: displayGoal.activeTimeMs,
            ...(displayGoal.lastReason === undefined
              ? {}
              : { lastReason: displayGoal.lastReason }),
          }
        : null,
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

function legacyStatusKind(
  payload: GoalStateRecordPayloadV2,
): LegacyGoalStatusKind {
  switch (payload.cause) {
    case 'create':
    case 'replace':
    case 'edit':
    case 'resume':
    case 'migrated':
      return 'set';
    case 'complete':
      return 'achieved';
    case 'clear':
      return 'cleared';
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
