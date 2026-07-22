/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  goalRequiresExactPermit,
  type GoalRecord,
  type GoalSnapshotV2,
} from './goal-protocol.js';
import {
  GoalConflictError,
  GoalInvalidTransitionError,
  elapsedActiveTime,
  parseGoalControlRequest,
  parseGoalSnapshotV2,
  parseGoalStateRecordPayloadV2,
  reduceGoalControl,
  reduceGoalTurnFinished,
} from './goal-reducer.js';

const goalRecord = (overrides: Partial<GoalRecord> = {}): GoalRecord => ({
  goalId: 'g-1',
  revision: 1,
  objective: 'ship',
  status: 'active',
  evidenceCursor: { recordId: 'r-100' },
  turnCount: 0,
  activeTimeMs: 0,
  createdAt: 100,
  updatedAt: 100,
  ...overrides,
});

const snapshot = (goal: GoalRecord | null): GoalSnapshotV2 => ({
  v: 2,
  goal,
  activity: 'idle',
});

describe('goal reducer', () => {
  it('replaces the same objective with a fresh identity and cursor', () => {
    const previous = goalRecord({ goalId: 'g-1', objective: 'ship' });
    const next = reduceGoalControl(previous, {
      request: {
        action: 'replace',
        objective: 'ship',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
      now: 200,
      nextGoalId: 'g-2',
      cursor: { recordId: 'r-200' },
    });

    expect(next).toMatchObject({
      goalId: 'g-2',
      revision: 1,
      objective: 'ship',
      status: 'active',
      evidenceCursor: { recordId: 'r-200' },
      turnCount: 0,
    });
  });

  it('edits in place and rejects evidence from the previous revision', () => {
    const previous = goalRecord({ goalId: 'g-1', revision: 4 });
    const next = reduceGoalControl(previous, {
      request: {
        action: 'edit',
        objective: 'new objective',
        expectedGoalId: 'g-1',
        expectedRevision: 4,
      },
      now: 300,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-300' },
    });

    expect(next).toMatchObject({
      goalId: 'g-1',
      revision: 5,
      objective: 'new objective',
      evidenceCursor: { recordId: 'r-300' },
    });
  });

  it('creates a trimmed active goal only when no goal exists', () => {
    const next = reduceGoalControl(null, {
      request: { action: 'create', objective: '  ship  ' },
      now: 100,
      nextGoalId: 'g-1',
      cursor: { recordId: 'r-100' },
    });

    expect(next).toEqual(goalRecord());
    expect(() =>
      reduceGoalControl(next, {
        request: { action: 'create', objective: 'another' },
        now: 200,
        nextGoalId: 'g-2',
        cursor: { recordId: 'r-200' },
      }),
    ).toThrow(GoalConflictError);
  });

  it('rejects empty objectives', () => {
    expect(() =>
      reduceGoalControl(null, {
        request: { action: 'create', objective: ' \n ' },
        now: 100,
        nextGoalId: 'g-1',
        cursor: { recordId: 'r-100' },
      }),
    ).toThrow(GoalInvalidTransitionError);
  });

  it('returns the current snapshot for stale identity and revision', () => {
    const previous = goalRecord({ revision: 4 });

    for (const request of [
      {
        action: 'pause' as const,
        expectedGoalId: 'g-other',
        expectedRevision: 4,
      },
      {
        action: 'pause' as const,
        expectedGoalId: 'g-1',
        expectedRevision: 3,
      },
    ]) {
      try {
        reduceGoalControl(previous, {
          request,
          now: 200,
          nextGoalId: 'unused',
          cursor: { recordId: 'r-200' },
        });
        throw new Error('expected conflict');
      } catch (error) {
        expect(error).toBeInstanceOf(GoalConflictError);
        expect((error as GoalConflictError).current).toEqual(
          snapshot(previous),
        );
      }
    }
  });

  it('pauses and resumes without changing revision or evidence cursor', () => {
    const paused = reduceGoalControl(goalRecord(), {
      request: {
        action: 'pause',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
      now: 150,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-150' },
    });
    const resumed = reduceGoalControl(paused, {
      request: {
        action: 'resume',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
      now: 200,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-200' },
    });

    expect(paused).toMatchObject({
      status: 'paused',
      revision: 1,
      evidenceCursor: { recordId: 'r-100' },
    });
    expect(resumed).toMatchObject({
      status: 'active',
      revision: 1,
      evidenceCursor: { recordId: 'r-100' },
    });
  });

  it('rejects resuming an already-active goal', () => {
    expect(() =>
      reduceGoalControl(goalRecord(), {
        request: {
          action: 'resume',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      }),
    ).toThrow(GoalInvalidTransitionError);
  });

  it.each(['paused', 'blocked', 'usage_limited'] as const)(
    'edits a %s goal without changing its status',
    (status) => {
      const next = reduceGoalControl(goalRecord({ status, revision: 4 }), {
        request: {
          action: 'edit',
          objective: 'new objective',
          expectedGoalId: 'g-1',
          expectedRevision: 4,
        },
        now: 300,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-300' },
      });

      expect(next).toMatchObject({ status, revision: 5 });
    },
  );

  it('rejects editing or resuming a completed goal', () => {
    const complete = goalRecord({ status: 'complete' });

    for (const request of [
      {
        action: 'edit' as const,
        objective: 'new objective',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
      {
        action: 'resume' as const,
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
    ]) {
      expect(() =>
        reduceGoalControl(complete, {
          request,
          now: 200,
          nextGoalId: 'unused',
          cursor: { recordId: 'r-200' },
        }),
      ).toThrow(GoalInvalidTransitionError);
    }
  });

  it('clears a matching goal', () => {
    expect(
      reduceGoalControl(goalRecord(), {
        request: {
          action: 'clear',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      }),
    ).toBeNull();
  });

  it('folds active elapsed time before each persisted transition', () => {
    const paused = reduceGoalControl(goalRecord(), {
      request: {
        action: 'pause',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
      now: 160,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-160' },
    });
    const resumed = reduceGoalControl(paused, {
      request: {
        action: 'resume',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
      now: 250,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-250' },
    });
    const pausedAgain = reduceGoalControl(resumed, {
      request: {
        action: 'pause',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
      now: 275,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-275' },
    });

    expect(paused?.activeTimeMs).toBe(60);
    expect(resumed?.activeTimeMs).toBe(60);
    expect(pausedAgain?.activeTimeMs).toBe(85);
    expect(elapsedActiveTime(resumed!, 275)).toBe(85);
  });

  it('never derives a terminal status from turn count or elapsed time', () => {
    let goal = goalRecord();
    for (let turn = 1; turn <= 150; turn += 1) {
      goal = reduceGoalTurnFinished(goal, {
        now: 100 + turn,
      });
    }

    expect(goal).toMatchObject({
      status: 'active',
      revision: 1,
      turnCount: 150,
      activeTimeMs: 150,
      evidenceCursor: { recordId: 'r-100' },
    });
  });

  it('finishes an in-flight turn after pause without resuming active time', () => {
    const paused = goalRecord({
      revision: 4,
      status: 'paused',
      turnCount: 2,
      activeTimeMs: 60,
      updatedAt: 160,
    });

    const finished = reduceGoalTurnFinished(paused, { now: 225 });

    expect(finished).toMatchObject({
      status: 'paused',
      revision: 4,
      evidenceCursor: { recordId: 'r-100' },
      turnCount: 3,
      activeTimeMs: 60,
      updatedAt: 225,
    });
  });

  it.each(['blocked', 'usage_limited', 'complete'] as const)(
    'rejects finishing a turn for a %s goal',
    (status) => {
      expect(() =>
        reduceGoalTurnFinished(goalRecord({ status }), { now: 200 }),
      ).toThrow(GoalInvalidTransitionError);
    },
  );

  it.each([
    [null, 'idle', false],
    [goalRecord(), 'idle', true],
    [goalRecord({ status: 'paused' }), 'idle', false],
    [goalRecord({ status: 'paused' }), 'running', true],
  ] as const)(
    'requires an exact permit for the matching goal and activity state',
    (goal, activity, expected) => {
      expect(goalRequiresExactPermit({ ...snapshot(goal), activity })).toBe(
        expected,
      );
    },
  );

  it('strictly parses persisted idle goal snapshots and control requests', () => {
    const record = goalRecord();
    expect(
      parseGoalStateRecordPayloadV2({
        v: 2,
        cause: 'create',
        snapshot: snapshot(record),
      }),
    ).toEqual({ v: 2, cause: 'create', snapshot: snapshot(record) });
    expect(
      parseGoalStateRecordPayloadV2({
        v: 2,
        cause: 'create',
        snapshot: { ...snapshot(record), activity: 'running' },
      }),
    ).toBeUndefined();
    expect(
      parseGoalControlRequest({ action: 'create', objective: 'ship' }),
    ).toEqual({
      action: 'create',
      objective: 'ship',
    });
    expect(
      parseGoalControlRequest({
        action: 'edit',
        objective: '  ',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      }),
    ).toBeUndefined();
    expect(
      parseGoalControlRequest({
        action: 'pause',
        expectedGoalId: 'g-1',
      }),
    ).toBeUndefined();
    expect(
      parseGoalControlRequest({
        action: 'pause',
        expectedGoalId: 'g-1',
        expectedRevision: 0,
      }),
    ).toBeUndefined();
  });

  it.each(['idle', 'running', 'verifying'] as const)(
    'parses %s activity in public wire snapshots',
    (activity) => {
      const value = { ...snapshot(goalRecord()), activity };

      expect(parseGoalSnapshotV2(value)).toEqual(value);
    },
  );

  it.each([
    ['zero count', { fingerprint: 'same', count: 0, turnIds: [] }],
    [
      'count above the blocker threshold',
      {
        fingerprint: 'same',
        count: 4,
        turnIds: ['turn-1', 'turn-2', 'turn-3', 'turn-4'],
      },
    ],
    [
      'count and turn ID mismatch',
      { fingerprint: 'same', count: 2, turnIds: ['turn-1'] },
    ],
    ['empty fingerprint', { fingerprint: '', count: 1, turnIds: ['turn-1'] }],
    ['empty turn ID', { fingerprint: 'same', count: 1, turnIds: [''] }],
    [
      'extra key',
      {
        fingerprint: 'same',
        count: 1,
        turnIds: ['turn-1'],
        unexpected: true,
      },
    ],
  ])('rejects a blocked audit with %s', (_label, blockedAudit) => {
    expect(
      parseGoalStateRecordPayloadV2({
        v: 2,
        cause: 'turn_finished',
        snapshot: snapshot(goalRecord()),
        blockedAudit,
      }),
    ).toBeUndefined();
  });

  it('parses and clones a valid blocked audit', () => {
    const blockedAudit = {
      fingerprint: 'same',
      count: 2,
      turnIds: ['turn-1', 'turn-2'],
    };
    const parsed = parseGoalStateRecordPayloadV2({
      v: 2,
      cause: 'turn_finished',
      snapshot: snapshot(goalRecord()),
      blockedAudit,
    });

    expect(parsed?.blockedAudit).toEqual(blockedAudit);
    expect(parsed?.blockedAudit).not.toBe(blockedAudit);
  });
});
