/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GOAL_CHECKPOINT_CLAIM_LIMIT,
  GOAL_CHECKPOINT_CLAIM_MAX_BYTES,
  GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS,
  GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT,
  GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  GOAL_STATE_VERSION,
  isGoalEvidenceProofKind,
  type GoalControlRequest,
  type GoalEvidenceCheckpoint,
  type GoalRecord,
  type GoalSnapshotV2,
  type GoalStateCause,
  type GoalStateRecordPayloadV2,
  type GoalStatus,
  type TranscriptCursor,
} from './goal-protocol.js';

const MAX_BLOCKED_AUDIT_COUNT = 3;

export interface GoalControlTransition {
  request: GoalControlRequest;
  now: number;
  nextGoalId: string;
  cursor: TranscriptCursor;
}

export interface GoalTurnFinishedTransition {
  now: number;
  lastReason?: string;
}

export class GoalConflictError extends Error {
  constructor(readonly current: GoalSnapshotV2) {
    super('Goal version does not match the current session Goal');
    this.name = 'GoalConflictError';
  }
}

export class GoalInvalidTransitionError extends Error {
  constructor(
    message: string,
    readonly current: GoalSnapshotV2,
  ) {
    super(message);
    this.name = 'GoalInvalidTransitionError';
  }
}

export function elapsedActiveTime(goal: GoalRecord, now: number): number {
  return (
    goal.activeTimeMs +
    (goal.status === 'active' ? Math.max(0, now - goal.updatedAt) : 0)
  );
}

export function reduceGoalControl(
  current: GoalRecord | null,
  transition: GoalControlTransition,
): GoalRecord | null {
  const { request } = transition;
  if (request.action === 'create') {
    if (current) throw new GoalConflictError(snapshotOf(current));
    return createGoal(
      transition.nextGoalId,
      normalizeObjective(request.objective, snapshotOf(null)),
      transition.now,
      transition.cursor,
    );
  }

  assertExpectedVersion(
    current,
    request.expectedGoalId,
    request.expectedRevision,
  );

  if (request.action === 'clear') return null;

  if (request.action === 'replace') {
    return createGoal(
      transition.nextGoalId,
      normalizeObjective(request.objective, snapshotOf(current)),
      transition.now,
      transition.cursor,
    );
  }

  if (request.action === 'edit') {
    if (current.status === 'complete') {
      throw new GoalInvalidTransitionError(
        'A completed Goal cannot be edited',
        snapshotOf(current),
      );
    }
    return transitionGoal(current, transition.now, {
      revision: current.revision + 1,
      objective: normalizeObjective(request.objective, snapshotOf(current)),
      evidenceCursor: copyCursor(transition.cursor),
      evidenceCheckpoint: undefined,
      lastReason: undefined,
    });
  }

  if (request.action === 'pause') {
    if (current.status !== 'active') {
      throw new GoalInvalidTransitionError(
        'Only an active Goal can be paused',
        snapshotOf(current),
      );
    }
    return transitionGoal(current, transition.now, { status: 'paused' });
  }

  if (current.status === 'complete') {
    throw new GoalInvalidTransitionError(
      'A completed Goal cannot be resumed',
      snapshotOf(current),
    );
  }
  if (current.status === 'active') {
    throw new GoalInvalidTransitionError(
      'An active Goal cannot be resumed',
      snapshotOf(current),
    );
  }
  if (
    current.status === 'usage_limited' &&
    (current.lastReason === GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON ||
      current.lastReason === GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON)
  ) {
    throw new GoalInvalidTransitionError(
      'An evidence-limited Goal cannot be resumed; edit or replace the Goal first',
      snapshotOf(current),
    );
  }
  if (request.action !== 'resume') {
    return assertNever(request, snapshotOf(current));
  }
  return transitionGoal(current, transition.now, {
    status: 'active',
  });
}

export function reduceGoalTurnFinished(
  current: GoalRecord,
  transition: GoalTurnFinishedTransition,
): GoalRecord {
  if (current.status !== 'active' && current.status !== 'paused') {
    throw new GoalInvalidTransitionError(
      'Only an active or paused Goal can finish a turn',
      snapshotOf(current),
    );
  }
  return transitionGoal(current, transition.now, {
    turnCount: current.turnCount + 1,
    ...(transition.lastReason === undefined
      ? {}
      : { lastReason: transition.lastReason }),
  });
}

export function parseGoalControlRequest(
  value: unknown,
): GoalControlRequest | undefined {
  if (!isRecord(value) || typeof value['action'] !== 'string') {
    return undefined;
  }

  switch (value['action']) {
    case 'create':
      if (!hasOnlyKeys(value, ['action', 'objective'])) return undefined;
      return typeof value['objective'] === 'string'
        ? parseObjectiveRequest(value['action'], value['objective'])
        : undefined;
    case 'replace':
    case 'edit':
      if (
        !hasOnlyKeys(value, [
          'action',
          'objective',
          'expectedGoalId',
          'expectedRevision',
        ]) ||
        typeof value['objective'] !== 'string' ||
        !isExpectedVersion(value)
      ) {
        return undefined;
      }
      return parseObjectiveVersionedRequest(
        value['action'],
        value['objective'],
        value['expectedGoalId'],
        value['expectedRevision'],
      );
    case 'pause':
    case 'resume':
    case 'clear':
      if (
        !hasOnlyKeys(value, ['action', 'expectedGoalId', 'expectedRevision']) ||
        !isExpectedVersion(value)
      ) {
        return undefined;
      }
      return {
        action: value['action'],
        expectedGoalId: value['expectedGoalId'],
        expectedRevision: value['expectedRevision'],
      };
    default:
      return undefined;
  }
}

export function parseGoalStateRecordPayloadV2(
  value: unknown,
): GoalStateRecordPayloadV2 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'v',
      'cause',
      'snapshot',
      'checkpointPending',
      'blockedAudit',
    ]) ||
    value['v'] !== GOAL_STATE_VERSION ||
    !isGoalStateCause(value['cause']) ||
    !isCheckpointPending(value['checkpointPending']) ||
    !isBlockedAudit(value['blockedAudit'])
  ) {
    return undefined;
  }
  const parsedSnapshot = parseGoalSnapshotV2(value['snapshot']);
  if (parsedSnapshot?.activity !== 'idle') return undefined;
  const checkpointPending = value['checkpointPending'];
  if (
    checkpointPending &&
    (parsedSnapshot.goal?.status !== 'active' ||
      checkpointPending.permit.goalId !== parsedSnapshot.goal.goalId ||
      checkpointPending.permit.revision !== parsedSnapshot.goal.revision ||
      checkpointPending.recordUuid ===
        parsedSnapshot.goal.evidenceCursor.recordId ||
      (value['cause'] !== 'turn_finished' &&
        value['cause'] !== 'verifier_reject'))
  ) {
    return undefined;
  }
  return {
    v: GOAL_STATE_VERSION,
    cause: value['cause'],
    snapshot: parsedSnapshot,
    ...(checkpointPending
      ? { checkpointPending: structuredClone(checkpointPending) }
      : {}),
    ...(value['blockedAudit']
      ? { blockedAudit: structuredClone(value['blockedAudit']) }
      : {}),
  };
}

export function parseGoalSnapshotV2(
  value: unknown,
): GoalSnapshotV2 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['v', 'goal', 'activity']) ||
    value['v'] !== GOAL_STATE_VERSION ||
    !isGoalActivity(value['activity'])
  ) {
    return undefined;
  }
  if (value['goal'] === null) {
    return {
      v: GOAL_STATE_VERSION,
      goal: null,
      activity: value['activity'],
    };
  }
  const goal = parseGoalRecord(value['goal']);
  return goal
    ? { v: GOAL_STATE_VERSION, goal, activity: value['activity'] }
    : undefined;
}

export function parseGoalStateCause(
  value: unknown,
): GoalStateCause | undefined {
  return isGoalStateCause(value) ? value : undefined;
}

function createGoal(
  goalId: string,
  objective: string,
  now: number,
  cursor: TranscriptCursor,
): GoalRecord {
  return {
    goalId,
    revision: 1,
    objective,
    status: 'active',
    evidenceCursor: copyCursor(cursor),
    turnCount: 0,
    activeTimeMs: 0,
    createdAt: now,
    updatedAt: now,
  };
}

function assertExpectedVersion(
  current: GoalRecord | null,
  expectedGoalId: string,
  expectedRevision: number,
): asserts current is GoalRecord {
  if (
    !current ||
    current.goalId !== expectedGoalId ||
    current.revision !== expectedRevision
  ) {
    throw new GoalConflictError(snapshotOf(current));
  }
}

function normalizeObjective(
  objective: string,
  current: GoalSnapshotV2,
): string {
  const normalized = objective.trim();
  if (!normalized) {
    throw new GoalInvalidTransitionError(
      'Goal objective must not be empty',
      current,
    );
  }
  return normalized;
}

function transitionGoal(
  goal: GoalRecord,
  now: number,
  changes: Partial<GoalRecord>,
): GoalRecord {
  return {
    ...goal,
    ...changes,
    activeTimeMs: elapsedActiveTime(goal, now),
    updatedAt: now,
  };
}

function snapshotOf(goal: GoalRecord | null): GoalSnapshotV2 {
  return { v: GOAL_STATE_VERSION, goal, activity: 'idle' };
}

function copyCursor(cursor: TranscriptCursor): TranscriptCursor {
  return { recordId: cursor.recordId };
}

function parseObjectiveRequest(
  action: 'create',
  objective: string,
): GoalControlRequest | undefined {
  const normalized = objective.trim();
  return normalized ? { action, objective: normalized } : undefined;
}

function parseObjectiveVersionedRequest(
  action: 'replace' | 'edit',
  objective: string,
  expectedGoalId: string,
  expectedRevision: number,
): GoalControlRequest | undefined {
  const normalized = objective.trim();
  return normalized
    ? { action, objective: normalized, expectedGoalId, expectedRevision }
    : undefined;
}

function parseGoalRecord(value: unknown): GoalRecord | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      'goalId',
      'revision',
      'objective',
      'status',
      'evidenceCursor',
      'turnCount',
      'activeTimeMs',
      'createdAt',
      'updatedAt',
      'evidenceCheckpoint',
      'lastReason',
    ]) ||
    typeof value['goalId'] !== 'string' ||
    !value['goalId'] ||
    !isNonNegativeInteger(value['revision']) ||
    value['revision'] === 0 ||
    typeof value['objective'] !== 'string' ||
    !value['objective'].trim() ||
    !isGoalStatus(value['status']) ||
    !isTranscriptCursor(value['evidenceCursor']) ||
    !isNonNegativeInteger(value['turnCount']) ||
    !isNonNegativeNumber(value['activeTimeMs']) ||
    !isFiniteNumber(value['createdAt']) ||
    !isFiniteNumber(value['updatedAt']) ||
    !isGoalEvidenceCheckpoint(value['evidenceCheckpoint']) ||
    (value['lastReason'] !== undefined &&
      typeof value['lastReason'] !== 'string')
  ) {
    return undefined;
  }
  if (
    value['evidenceCheckpoint'] &&
    value['evidenceCursor'].recordId !==
      value['evidenceCheckpoint'].checkpointId
  ) {
    return undefined;
  }
  return {
    goalId: value['goalId'],
    revision: value['revision'],
    objective: value['objective'],
    status: value['status'],
    evidenceCursor: copyCursor(value['evidenceCursor']),
    turnCount: value['turnCount'],
    activeTimeMs: value['activeTimeMs'],
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
    ...(value['evidenceCheckpoint'] === undefined
      ? {}
      : {
          evidenceCheckpoint: structuredClone(value['evidenceCheckpoint']),
        }),
    ...(value['lastReason'] === undefined
      ? {}
      : { lastReason: value['lastReason'] }),
  };
}

function isExpectedVersion(value: Record<string, unknown>): value is Record<
  string,
  unknown
> & {
  expectedGoalId: string;
  expectedRevision: number;
} {
  return (
    typeof value['expectedGoalId'] === 'string' &&
    value['expectedGoalId'].length > 0 &&
    isNonNegativeInteger(value['expectedRevision']) &&
    value['expectedRevision'] > 0
  );
}

function isTranscriptCursor(value: unknown): value is TranscriptCursor {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['recordId']) &&
    (typeof value['recordId'] === 'string' || value['recordId'] === null)
  );
}

function isGoalStatus(value: unknown): value is GoalStatus {
  return (
    value === 'active' ||
    value === 'paused' ||
    value === 'blocked' ||
    value === 'usage_limited' ||
    value === 'complete'
  );
}

function isGoalActivity(value: unknown): value is GoalSnapshotV2['activity'] {
  return value === 'idle' || value === 'running' || value === 'verifying';
}

function isGoalStateCause(value: unknown): value is GoalStateCause {
  return (
    value === 'create' ||
    value === 'replace' ||
    value === 'edit' ||
    value === 'pause' ||
    value === 'resume' ||
    value === 'turn_finished' ||
    value === 'checkpoint' ||
    value === 'verifier_accept' ||
    value === 'verifier_reject' ||
    value === 'complete' ||
    value === 'blocked' ||
    value === 'usage_limited' ||
    value === 'clear' ||
    value === 'migrated'
  );
}

function isGoalEvidenceCheckpoint(
  value: unknown,
): value is GoalEvidenceCheckpoint | undefined {
  if (value === undefined) return true;
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['checkpointId', 'createdAt', 'claims']) ||
    typeof value['checkpointId'] !== 'string' ||
    value['checkpointId'].length === 0 ||
    !isFiniteNumber(value['createdAt']) ||
    !Array.isArray(value['claims']) ||
    value['claims'].length === 0 ||
    value['claims'].length > GOAL_CHECKPOINT_CLAIM_LIMIT
  ) {
    return false;
  }
  let checkpointBytes = 0;
  for (const [index, claim] of value['claims'].entries()) {
    if (
      !isRecord(claim) ||
      !hasOnlyKeys(claim, ['id', 'proofKind', 'claim', 'sourceRefs']) ||
      claim['id'] !== `${value['checkpointId']}:${index + 1}` ||
      !isGoalEvidenceProofKind(claim['proofKind']) ||
      typeof claim['claim'] !== 'string' ||
      claim['claim'].trim().length === 0 ||
      [...claim['claim']].length > GOAL_CHECKPOINT_CLAIM_MAX_CHARACTERS ||
      !Array.isArray(claim['sourceRefs']) ||
      claim['sourceRefs'].length === 0 ||
      claim['sourceRefs'].length > GOAL_CHECKPOINT_SOURCE_REFERENCE_LIMIT ||
      new Set(claim['sourceRefs']).size !== claim['sourceRefs'].length ||
      claim['sourceRefs'].some(
        (reference) => typeof reference !== 'string' || reference.length === 0,
      )
    ) {
      return false;
    }
    checkpointBytes += new TextEncoder().encode(claim['claim']).byteLength;
    if (checkpointBytes > GOAL_CHECKPOINT_CLAIM_MAX_BYTES) return false;
  }
  return true;
}

function isCheckpointPending(
  value: unknown,
): value is GoalStateRecordPayloadV2['checkpointPending'] {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['permit', 'recordUuid']) &&
      isGoalTurnPermit(value['permit']) &&
      typeof value['recordUuid'] === 'string' &&
      value['recordUuid'].length > 0)
  );
}

function isGoalTurnPermit(value: unknown): value is {
  goalId: string;
  revision: number;
  turnId: string;
} {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['goalId', 'revision', 'turnId']) &&
    typeof value['goalId'] === 'string' &&
    value['goalId'].length > 0 &&
    isNonNegativeInteger(value['revision']) &&
    value['revision'] > 0 &&
    typeof value['turnId'] === 'string' &&
    value['turnId'].length > 0
  );
}

function isBlockedAudit(
  value: unknown,
): value is GoalStateRecordPayloadV2['blockedAudit'] {
  return (
    value === undefined ||
    (isRecord(value) &&
      hasOnlyKeys(value, ['fingerprint', 'count', 'turnIds']) &&
      typeof value['fingerprint'] === 'string' &&
      value['fingerprint'].length > 0 &&
      isNonNegativeInteger(value['count']) &&
      value['count'] > 0 &&
      value['count'] <= MAX_BLOCKED_AUDIT_COUNT &&
      Array.isArray(value['turnIds']) &&
      value['turnIds'].length === value['count'] &&
      value['turnIds'].every(
        (turnId) => typeof turnId === 'string' && turnId.length > 0,
      ))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertNever(value: never, snapshot: GoalSnapshotV2): never {
  throw new GoalInvalidTransitionError(
    `Unsupported Goal control action: ${String(value)}`,
    snapshot,
  );
}
