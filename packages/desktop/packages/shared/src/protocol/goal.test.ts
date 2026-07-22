import { describe, expect, it } from 'bun:test';
import type { GoalSnapshotV2 } from './dto.ts';
import { parseGoalSnapshotV2 } from './goal.ts';

describe('Goal protocol v2', () => {
  it('preserves all authoritative lifecycle fields', () => {
    const value = {
      v: 2,
      goal: {
        goalId: 'goal-1',
        revision: 2,
        objective: 'Ship the desktop surface',
        status: 'usage_limited',
        evidenceCursor: { recordId: 'record-2' },
        turnCount: 4,
        activeTimeMs: 21_000,
        createdAt: 1_000,
        updatedAt: 22_000,
        lastReason: 'Provider window exhausted',
      },
      activity: 'verifying',
    } satisfies GoalSnapshotV2;

    expect(parseGoalSnapshotV2(value)).toEqual(value);
  });

  it('does not infer v2 state from a legacy active projection', () => {
    expect(
      parseGoalSnapshotV2({
        active: { condition: 'legacy', iterations: 2, setAt: 1_000 },
      }),
    ).toBeUndefined();
  });

  it('rejects malformed optimistic-concurrency versions', () => {
    expect(
      parseGoalSnapshotV2({
        v: 2,
        goal: {
          goalId: 'goal-1',
          revision: 0,
          objective: 'invalid',
          status: 'active',
          evidenceCursor: { recordId: null },
          turnCount: 0,
          activeTimeMs: 0,
          createdAt: 1,
          updatedAt: 1,
        },
        activity: 'idle',
      }),
    ).toBeUndefined();
  });

  it('does not coerce non-string activity values into protocol states', () => {
    expect(
      parseGoalSnapshotV2({
        v: 2,
        goal: null,
        activity: ['idle'],
      }),
    ).toBeUndefined();
  });

  it('rejects unknown keys at every Goal protocol layer', () => {
    const valid = {
      v: 2,
      goal: {
        goalId: 'goal-1',
        revision: 1,
        objective: 'Strict Goal',
        status: 'active',
        evidenceCursor: { recordId: null },
        turnCount: 0,
        activeTimeMs: 0,
        createdAt: 1,
        updatedAt: 1,
      },
      activity: 'idle',
    };

    expect(parseGoalSnapshotV2({ ...valid, extra: true })).toBeUndefined();
    expect(
      parseGoalSnapshotV2({
        ...valid,
        goal: { ...valid.goal, extra: true },
      }),
    ).toBeUndefined();
    expect(
      parseGoalSnapshotV2({
        ...valid,
        goal: {
          ...valid.goal,
          evidenceCursor: { recordId: null, extra: true },
        },
      }),
    ).toBeUndefined();
  });

  it('rejects empty identifiers/objectives and non-finite timestamps', () => {
    const goal = {
      goalId: 'goal-1',
      revision: 1,
      objective: 'Strict Goal',
      status: 'active',
      evidenceCursor: { recordId: null },
      turnCount: 0,
      activeTimeMs: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    const snapshot = (overrides: Record<string, unknown>) => ({
      v: 2,
      goal: { ...goal, ...overrides },
      activity: 'idle',
    });

    expect(parseGoalSnapshotV2(snapshot({ goalId: '' }))).toBeUndefined();
    expect(
      parseGoalSnapshotV2(snapshot({ objective: '   ' })),
    ).toBeUndefined();
    expect(
      parseGoalSnapshotV2(snapshot({ createdAt: Number.POSITIVE_INFINITY })),
    ).toBeUndefined();
    expect(
      parseGoalSnapshotV2(snapshot({ updatedAt: Number.NaN })),
    ).toBeUndefined();
  });
});
