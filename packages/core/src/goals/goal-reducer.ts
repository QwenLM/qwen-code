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
  GOAL_STATE_VERSION,
  goalLimitKindForReason,
  isGoalEvidenceProofKind,
  isGoalLimitKind,
  isGoalTokenBudgetSpent,
  validateGoalPauseReason,
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
  /**
   * The autonomous spend window the caller is arming, in `tokensUsed` tokens.
   * A create or replace stamps it as the new Goal's `tokenBudget`; a resume
   * or edit of a Goal whose ceiling is spent re-arms `tokensUsed + grant`.
   * Absent means the transition arms nothing -- a created Goal is then
   * unbounded.
   */
  tokenBudgetGrant?: number;
}

export interface GoalTurnFinishedTransition {
  now: number;
  lastReason?: string;
  /** Tokens billed to the turn that just finished. */
  tokensUsed?: number;
  /**
   * Set when the finishing turn was the spend window's wind-down hand-off
   * and was delivered to the model.
   */
  windDownTurnId?: string;
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
      transition.tokenBudgetGrant,
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
      transition.tokenBudgetGrant,
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
      checkpointStalls: undefined,
      ...rearmedTokenBudget(current, transition.tokenBudgetGrant),
      lastReason: undefined,
      limitKind: undefined,
    });
  }

  if (request.action === 'pause') {
    if (current.status !== 'active') {
      throw new GoalInvalidTransitionError(
        'Only an active Goal can be paused',
        snapshotOf(current),
      );
    }
    // A pause without a reason clears `lastReason` rather than keeping it.
    // The field is rendered as the reason the Goal is in its current state,
    // and the value it would otherwise hold is the previous turn's verifier
    // rejection -- which explains why the Goal was still running, not why it
    // stopped.
    return transitionGoal(current, transition.now, {
      status: 'paused',
      lastReason: request.reason,
    });
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
    request.action === 'resume' &&
    current.status === 'usage_limited' &&
    current.limitKind === 'token_budget'
  ) {
    // A budget stop is a spent authorization, not a fault: resuming IS the
    // user paying for another window, so re-arm the ceiling ahead of the
    // meter rather than resetting the meter -- `tokensUsed` stays honest
    // accounting across the Goal's whole life.
    return transitionGoal(current, transition.now, {
      status: 'active',
      ...rearmedTokenBudget(current, transition.tokenBudgetGrant),
      lastReason: undefined,
      limitKind: undefined,
    });
  }
  if (request.action !== 'resume') {
    return assertNever(request, snapshotOf(current));
  }
  // A Goal stopped by an evidence bound resumes from a fresh evidence window
  // rather than refusing to resume at all. The bound was reached because the
  // catalog could no longer hold everything since the cursor; carrying that
  // same cursor and checkpoint back into an active Goal would reach it again
  // on the next turn. Repointing the cursor to the resume boundary and
  // dropping the checkpoint is the same reset `/goal edit` already performs,
  // without discarding the objective or minting a new revision.
  //
  // The cost is explicit and belongs to the user who asked to resume:
  // evidence recorded before this point is no longer citable, so a terminal
  // proposal must prove itself from what the resumed run produces.
  if (current.status === 'usage_limited' && isEvidenceLimited(current)) {
    return transitionGoal(current, transition.now, {
      status: 'active',
      evidenceCursor: copyCursor(transition.cursor),
      evidenceCheckpoint: undefined,
      // The streak counts checkpoints against one window; this resume starts
      // a different one, so carrying it over would spend the new window's
      // allowance on the old window's failures.
      checkpointStalls: undefined,
      ...rearmedTokenBudget(current, transition.tokenBudgetGrant),
      lastReason: undefined,
      limitKind: undefined,
    });
  }
  return transitionGoal(current, transition.now, {
    status: 'active',
    ...rearmedTokenBudget(current, transition.tokenBudgetGrant),
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
    tokensUsed: current.tokensUsed + Math.max(0, transition.tokensUsed ?? 0),
    ...(transition.lastReason === undefined
      ? {}
      : { lastReason: transition.lastReason }),
    ...(transition.windDownTurnId === undefined
      ? {}
      : { windDownTurnId: transition.windDownTurnId }),
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
    case 'pause': {
      if (
        !hasOnlyKeys(value, [
          'action',
          'expectedGoalId',
          'expectedRevision',
          'reason',
        ]) ||
        !isExpectedVersion(value)
      ) {
        return undefined;
      }
      const reason = value['reason'];
      if (reason !== undefined) {
        if (typeof reason !== 'string' || validateGoalPauseReason(reason)) {
          return undefined;
        }
      }
      return {
        action: 'pause',
        expectedGoalId: value['expectedGoalId'],
        expectedRevision: value['expectedRevision'],
        ...(reason === undefined ? {} : { reason }),
      };
    }
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
    !hasOnlyKeys(value, ['v', 'goal', 'activity', 'clearedGoal']) ||
    value['v'] !== GOAL_STATE_VERSION ||
    !isGoalActivity(value['activity'])
  ) {
    return undefined;
  }
  if (value['goal'] === null) {
    const clearedGoal = parseGoalOrder(value['clearedGoal']);
    if (value['clearedGoal'] !== undefined && !clearedGoal) return undefined;
    return {
      v: GOAL_STATE_VERSION,
      goal: null,
      activity: value['activity'],
      ...(clearedGoal ? { clearedGoal } : {}),
    };
  }
  if (value['clearedGoal'] !== undefined) return undefined;
  const goal = parseGoalRecord(value['goal']);
  return goal
    ? { v: GOAL_STATE_VERSION, goal, activity: value['activity'] }
    : undefined;
}

function parseGoalOrder(value: unknown): GoalSnapshotV2['clearedGoal'] {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['goalId', 'revision', 'updatedAt']) ||
    typeof value['goalId'] !== 'string' ||
    !value['goalId'] ||
    !isNonNegativeInteger(value['revision']) ||
    value['revision'] === 0 ||
    !isFiniteNumber(value['updatedAt'])
  ) {
    return undefined;
  }
  return {
    goalId: value['goalId'],
    revision: value['revision'],
    updatedAt: value['updatedAt'],
  };
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
  tokenBudget: number | undefined,
): GoalRecord {
  return {
    goalId,
    revision: 1,
    objective,
    status: 'active',
    evidenceCursor: copyCursor(cursor),
    turnCount: 0,
    activeTimeMs: 0,
    tokensUsed: 0,
    // A non-finite grant (a host opting out) arms nothing: `Infinity` would
    // not survive the JSON journal, so "unbounded" is spelled as no field.
    ...(tokenBudget !== undefined && Number.isFinite(tokenBudget)
      ? { tokenBudget }
      : {}),
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

/**
 * Whether a stopped Goal was stopped by one of the evidence bounds.
 *
 * `limitKind` is the field of record, matched by kind rather than presence:
 * `token_budget` is also a `limitKind`, and a budget-stopped Goal is exactly
 * the one resume must accept. The `lastReason` comparison behind it reads
 * Goals persisted before `limitKind` existed, where the sentinel prose was
 * the only marker a transition could key off.
 */
function isEvidenceLimited(goal: GoalRecord): boolean {
  return (
    goal.limitKind === 'evidence_catalog' ||
    goal.limitKind === 'checkpoint_request' ||
    (goal.lastReason !== undefined &&
      goalLimitKindForReason(goal.lastReason) !== undefined)
  );
}

/**
 * The budget change an explicit user action (edit, or a resume of a Goal
 * whose ceiling is spent) arms: a finite grant moves a spent ceiling to
 * `tokensUsed + grant`, while a non-finite opt-out clears it. An unspent
 * ceiling is left alone, and a Goal with no ceiling stays unbounded -- budgets
 * are armed at creation, never retrofitted.
 */
function rearmedTokenBudget(
  current: GoalRecord,
  grant: number | undefined,
): Partial<GoalRecord> {
  if (grant === undefined || !isGoalTokenBudgetSpent(current)) {
    return {};
  }
  // A new window gets its own wind-down: the marker belongs to the old one.
  return Number.isFinite(grant)
    ? { tokenBudget: current.tokensUsed + grant, windDownTurnId: undefined }
    : { tokenBudget: undefined, windDownTurnId: undefined };
}

function transitionGoal(
  goal: GoalRecord,
  now: number,
  changes: Partial<GoalRecord>,
): GoalRecord {
  const transitioned = {
    ...goal,
    ...changes,
    activeTimeMs: elapsedActiveTime(goal, now),
    updatedAt: now,
  };
  if ('tokenBudget' in changes && changes.tokenBudget === undefined) {
    delete transitioned.tokenBudget;
  }
  if ('windDownTurnId' in changes && changes.windDownTurnId === undefined) {
    delete transitioned.windDownTurnId;
  }
  return transitioned;
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
      'tokensUsed',
      'tokenBudget',
      'windDownTurnId',
      'createdAt',
      'updatedAt',
      'evidenceCheckpoint',
      'checkpointStalls',
      'lastReason',
      'limitKind',
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
    (value['tokensUsed'] !== undefined &&
      !isNonNegativeNumber(value['tokensUsed'])) ||
    (value['tokenBudget'] !== undefined &&
      !isNonNegativeNumber(value['tokenBudget'])) ||
    (value['windDownTurnId'] !== undefined &&
      (typeof value['windDownTurnId'] !== 'string' ||
        !value['windDownTurnId'])) ||
    !isFiniteNumber(value['createdAt']) ||
    !isFiniteNumber(value['updatedAt']) ||
    !isGoalEvidenceCheckpoint(value['evidenceCheckpoint']) ||
    (value['checkpointStalls'] !== undefined &&
      !isNonNegativeInteger(value['checkpointStalls'])) ||
    (value['lastReason'] !== undefined &&
      typeof value['lastReason'] !== 'string') ||
    (value['limitKind'] !== undefined &&
      (!isGoalLimitKind(value['limitKind']) ||
        value['status'] !== 'usage_limited'))
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
    // Goals persisted before `tokensUsed` existed carry no spend to restore.
    tokensUsed: value['tokensUsed'] ?? 0,
    // And no budget: a Goal from before budgets existed stays unbounded.
    ...(value['tokenBudget'] === undefined
      ? {}
      : { tokenBudget: value['tokenBudget'] }),
    ...(value['windDownTurnId'] === undefined
      ? {}
      : { windDownTurnId: value['windDownTurnId'] }),
    createdAt: value['createdAt'],
    updatedAt: value['updatedAt'],
    ...(value['evidenceCheckpoint'] === undefined
      ? {}
      : {
          evidenceCheckpoint: structuredClone(value['evidenceCheckpoint']),
        }),
    // Zero is spelled as no field; a persisted 0 restores the same way.
    ...(value['checkpointStalls']
      ? { checkpointStalls: value['checkpointStalls'] }
      : {}),
    ...(value['lastReason'] === undefined
      ? {}
      : { lastReason: value['lastReason'] }),
    ...(value['limitKind'] === undefined
      ? {}
      : { limitKind: value['limitKind'] }),
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
