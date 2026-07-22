import type { GoalRecord, GoalSnapshotV2 } from './dto.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function parseGoalRecord(value: unknown): GoalRecord | undefined {
  if (!isRecord(value)) return undefined;
  const evidenceCursor = value.evidenceCursor;
  if (
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
      'lastReason',
    ]) ||
    !isRecord(evidenceCursor) ||
    !hasOnlyKeys(evidenceCursor, ['recordId'])
  ) {
    return undefined;
  }
  const recordId = evidenceCursor.recordId;
  const status = value.status;
  if (
    typeof value.goalId !== 'string' ||
    value.goalId.length === 0 ||
    typeof value.revision !== 'number' ||
    !Number.isInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.objective !== 'string' ||
    value.objective.trim().length === 0 ||
    !['active', 'paused', 'blocked', 'usage_limited', 'complete'].includes(
      typeof status === 'string' ? status : '',
    ) ||
    (recordId !== null && typeof recordId !== 'string') ||
    typeof value.turnCount !== 'number' ||
    !Number.isInteger(value.turnCount) ||
    value.turnCount < 0 ||
    !isNonNegativeNumber(value.activeTimeMs) ||
    typeof value.createdAt !== 'number' ||
    !Number.isFinite(value.createdAt) ||
    typeof value.updatedAt !== 'number' ||
    !Number.isFinite(value.updatedAt) ||
    (value.lastReason !== undefined && typeof value.lastReason !== 'string')
  ) {
    return undefined;
  }

  return {
    goalId: value.goalId,
    revision: value.revision,
    objective: value.objective,
    status: status as GoalRecord['status'],
    evidenceCursor: { recordId: recordId as string | null },
    turnCount: value.turnCount,
    activeTimeMs: value.activeTimeMs,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(typeof value.lastReason === 'string'
      ? { lastReason: value.lastReason }
      : {}),
  };
}

export function parseGoalSnapshotV2(
  value: unknown,
): GoalSnapshotV2 | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['v', 'goal', 'activity']) ||
    value.v !== 2
  ) {
    return undefined;
  }
  const activity = value.activity;
  if (
    typeof activity !== 'string' ||
    !['idle', 'running', 'verifying'].includes(activity)
  ) {
    return undefined;
  }
  if (value.goal === null) {
    return {
      v: 2,
      goal: null,
      activity: activity as GoalSnapshotV2['activity'],
    };
  }
  const goal = parseGoalRecord(value.goal);
  return goal
    ? { v: 2, goal, activity: activity as GoalSnapshotV2['activity'] }
    : undefined;
}
