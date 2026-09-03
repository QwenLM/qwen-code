/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  goalLimitKindForReason,
  goalTokenBudgetReason,
  goalRequiresExactPermit,
  GOAL_PAUSE_REASON_COMMAND,
  GOAL_PAUSE_REASON_MAX_CHARACTERS,
  GOAL_PAUSE_REASON_USER_INTERRUPT,
  type GoalControlRequest,
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

const FORMER_GOAL_CONTINUATION_LIMIT = 50;

const goalRecord = (overrides: Partial<GoalRecord> = {}): GoalRecord => ({
  goalId: 'g-1',
  revision: 1,
  objective: 'ship',
  status: 'active',
  evidenceCursor: { recordId: 'r-100' },
  turnCount: 0,
  activeTimeMs: 0,
  tokensUsed: 0,
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

  it('clears lastReason when editing the objective', () => {
    const previous = goalRecord({
      goalId: 'g-1',
      revision: 2,
      lastReason: 'stale verifier rejection',
    });
    const next = reduceGoalControl(previous, {
      request: {
        action: 'edit',
        objective: 'updated objective',
        expectedGoalId: 'g-1',
        expectedRevision: 2,
      },
      now: 300,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-300' },
    });

    expect(next?.lastReason).toBeUndefined();
    expect(next?.objective).toBe('updated objective');
  });

  it('clears the evidence checkpoint when editing the objective', () => {
    const previous = goalRecord({
      revision: 2,
      evidenceCursor: { recordId: 'checkpoint-1' },
      evidenceCheckpoint: {
        checkpointId: 'checkpoint-1',
        createdAt: 42,
        claims: [
          {
            id: 'checkpoint-1:1',
            proofKind: 'external_fact',
            claim: 'The focused suite passed.',
            sourceRefs: ['tool-1'],
          },
        ],
      },
    });
    const next = reduceGoalControl(previous, {
      request: {
        action: 'edit',
        objective: 'updated objective',
        expectedGoalId: 'g-1',
        expectedRevision: 2,
      },
      now: 300,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-300' },
    });

    expect(next?.evidenceCheckpoint).toBeUndefined();
    expect(next?.evidenceCursor).toEqual({ recordId: 'r-300' });
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

  it('records the pause reason a host supplies', () => {
    const paused = reduceGoalControl(
      goalRecord({ lastReason: 'the verifier wanted the test output pasted' }),
      {
        request: {
          action: 'pause',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
          reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
        },
        now: 150,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-150' },
      },
    );

    expect(paused?.status).toBe('paused');
    expect(paused?.lastReason).toBe(GOAL_PAUSE_REASON_USER_INTERRUPT);
  });

  it('clears a stale reason when a pause supplies none', () => {
    // The value it would otherwise keep is the previous turn's verifier
    // rejection, which explains why the Goal was still running rather than
    // why it stopped -- so a reasonless pause must not inherit it.
    const paused = reduceGoalControl(
      goalRecord({ lastReason: 'the verifier wanted the test output pasted' }),
      {
        request: {
          action: 'pause',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        now: 150,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-150' },
      },
    );

    expect(paused?.status).toBe('paused');
    expect(paused?.lastReason).toBeUndefined();
  });

  it('parses a pause reason, and rejects one that is empty, oversized, or misplaced', () => {
    expect(
      parseGoalControlRequest({
        action: 'pause',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
        reason: GOAL_PAUSE_REASON_COMMAND,
      }),
    ).toEqual({
      action: 'pause',
      expectedGoalId: 'g-1',
      expectedRevision: 1,
      reason: GOAL_PAUSE_REASON_COMMAND,
    });

    for (const reason of [
      '   ',
      '',
      'x'.repeat(GOAL_PAUSE_REASON_MAX_CHARACTERS + 1),
      42,
      { text: 'nope' },
    ]) {
      expect(
        parseGoalControlRequest({
          action: 'pause',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
          reason,
        }),
      ).toBeUndefined();
    }

    // Only a pause carries one: resume and clear stay exact-key requests.
    for (const action of ['resume', 'clear'] as const) {
      expect(
        parseGoalControlRequest({
          action,
          expectedGoalId: 'g-1',
          expectedRevision: 1,
          reason: GOAL_PAUSE_REASON_COMMAND,
        }),
      ).toBeUndefined();
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

  it('clears the pause reason when a paused goal resumes', () => {
    const paused = reduceGoalControl(goalRecord(), {
      request: {
        action: 'pause',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
        reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
      },
      now: 150,
      nextGoalId: 'unused',
      cursor: { recordId: 'r-150' },
    });
    expect(paused?.lastReason).toBe(GOAL_PAUSE_REASON_USER_INTERRUPT);

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

    expect(resumed?.status).toBe('active');
    expect(resumed?.lastReason).toBeUndefined();
  });

  it("keeps a blocked goal's reason when it resumes", () => {
    const resumed = reduceGoalControl(
      goalRecord({ status: 'blocked', lastReason: 'Waiting on a credential.' }),
      {
        request: {
          action: 'resume',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      },
    );

    expect(resumed?.status).toBe('active');
    expect(resumed?.lastReason).toBe('Waiting on a credential.');
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

  it.each(['blocked', 'usage_limited'] as const)(
    'resumes a %s goal without changing revision or evidence cursor',
    (status) => {
      const resumed = reduceGoalControl(goalRecord({ status, revision: 4 }), {
        request: {
          action: 'resume',
          expectedGoalId: 'g-1',
          expectedRevision: 4,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      });

      expect(resumed).toMatchObject({
        status: 'active',
        revision: 4,
        evidenceCursor: { recordId: 'r-100' },
      });
    },
  );

  it('preserves the cumulative turn count when resuming a limited goal', () => {
    const resumed = reduceGoalControl(
      goalRecord({
        status: 'usage_limited',
        revision: 4,
        turnCount: FORMER_GOAL_CONTINUATION_LIMIT,
      }),
      {
        request: {
          action: 'resume',
          expectedGoalId: 'g-1',
          expectedRevision: 4,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      },
    );

    expect(resumed).toMatchObject({
      status: 'active',
      revision: 4,
      turnCount: FORMER_GOAL_CONTINUATION_LIMIT,
      evidenceCursor: { recordId: 'r-100' },
    });
  });

  it.each(['evidence_catalog', 'checkpoint_request'] as const)(
    'resumes a Goal limited by %s from a fresh evidence window',
    (limitKind) => {
      const resumed = reduceGoalControl(
        goalRecord({
          status: 'usage_limited',
          revision: 4,
          limitKind,
          lastReason: 'a reason the guard no longer has to recognise',
          evidenceCheckpoint: {
            checkpointId: 'r-100',
            createdAt: 1,
            claims: [
              {
                id: 'r-100:1',
                proofKind: 'external_fact',
                claim: 'note-01.md exists',
                sourceRefs: ['r-99'],
              },
            ],
          },
        }),
        {
          request: {
            action: 'resume',
            expectedGoalId: 'g-1',
            expectedRevision: 4,
          },
          now: 200,
          nextGoalId: 'unused',
          cursor: { recordId: 'r-200' },
        },
      );

      // Same objective, same revision, same accumulated turn count — only the
      // evidence window resets, because carrying the exhausted one back into
      // an active Goal would exhaust it again on the next turn.
      expect(resumed).toMatchObject({
        status: 'active',
        revision: 4,
        objective: 'ship',
        evidenceCursor: { recordId: 'r-200' },
      });
      expect(resumed?.evidenceCheckpoint).toBeUndefined();
      expect(resumed?.limitKind).toBeUndefined();
      expect(resumed?.lastReason).toBeUndefined();
    },
  );

  it('resets the checkpoint stall streak when a resume restarts the window', () => {
    // The streak counts checkpoints against one window. This resume starts a
    // different one, so carrying the count over would spend the new window's
    // allowance on the old window's failures -- a Goal resumed at two stalls
    // would stop again after a single stalled checkpoint.
    const resumed = reduceGoalControl(
      goalRecord({
        status: 'usage_limited',
        limitKind: 'evidence_catalog',
        checkpointStalls: 2,
      }),
      {
        request: {
          action: 'resume',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      },
    );

    expect(resumed).toMatchObject({ status: 'active' });
    expect(resumed?.checkpointStalls).toBeUndefined();
  });

  it('keeps the stall streak across a resume that does not restart the window', () => {
    // A paused Goal resumes into the same evidence window it left, so the
    // streak it accumulated there is still the truth about that window.
    const resumed = reduceGoalControl(
      goalRecord({ status: 'paused', checkpointStalls: 2 }),
      {
        request: {
          action: 'resume',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      },
    );

    expect(resumed).toMatchObject({ status: 'active', checkpointStalls: 2 });
  });

  it.each([
    [GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON, 'evidence_catalog'],
    [GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON, 'checkpoint_request'],
    ['An operational limit', undefined],
  ] as const)(
    'maps a Goal limit reason only to its canonical kind',
    (reason, expected) => {
      expect(goalLimitKindForReason(reason)).toBe(expected);
    },
  );

  it.each([
    GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
    GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
  ])(
    'resets the window for a pre-limitKind Goal known only by its sentinel prose',
    (lastReason) => {
      const resumed = reduceGoalControl(
        goalRecord({ status: 'usage_limited', revision: 4, lastReason }),
        {
          request: {
            action: 'resume',
            expectedGoalId: 'g-1',
            expectedRevision: 4,
          },
          now: 200,
          nextGoalId: 'unused',
          cursor: { recordId: 'r-200' },
        },
      );

      expect(resumed).toMatchObject({
        status: 'active',
        evidenceCursor: { recordId: 'r-200' },
      });
      expect(resumed?.lastReason).toBeUndefined();
    },
  );

  it('keeps the window of an operationally limited Goal when it resumes', () => {
    // Only the enumerated evidence bounds reset the window. A `usage_limited`
    // Goal stopped by a transient operational failure keeps its cursor and
    // checkpoint, so a resume does not throw away citable evidence it never
    // had a problem with.
    const resumed = reduceGoalControl(
      goalRecord({
        status: 'usage_limited',
        revision: 4,
        lastReason: 'Goal checkpoint recovery dependencies are unavailable',
        evidenceCheckpoint: {
          checkpointId: 'r-100',
          createdAt: 1,
          claims: [
            {
              id: 'r-100:1',
              proofKind: 'external_fact',
              claim: 'note-01.md exists',
              sourceRefs: ['r-99'],
            },
          ],
        },
      }),
      {
        request: {
          action: 'resume',
          expectedGoalId: 'g-1',
          expectedRevision: 4,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      },
    );

    expect(resumed).toMatchObject({
      status: 'active',
      evidenceCursor: { recordId: 'r-100' },
    });
    expect(resumed?.evidenceCheckpoint).toBeDefined();
  });

  it('clears limitKind when the objective is edited', () => {
    const edited = reduceGoalControl(
      goalRecord({
        status: 'usage_limited',
        revision: 4,
        limitKind: 'evidence_catalog',
        lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
      }),
      {
        request: {
          action: 'edit',
          objective: 'ship something else',
          expectedGoalId: 'g-1',
          expectedRevision: 4,
        },
        now: 200,
        nextGoalId: 'unused',
        cursor: { recordId: 'r-200' },
      },
    );

    expect(edited?.limitKind).toBeUndefined();
    expect(edited?.lastReason).toBeUndefined();
  });

  it('rejects an unsupported control action instead of resuming', () => {
    expect(() =>
      reduceGoalControl(goalRecord({ status: 'paused' }), {
        request: {
          action: 'archive',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        } as unknown as GoalControlRequest,
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
      tokensUsed: 0,
      evidenceCursor: { recordId: 'r-100' },
    });
  });

  it('finishes an in-flight turn after pause without resuming active time', () => {
    const paused = goalRecord({
      revision: 4,
      status: 'paused',
      turnCount: 2,
      activeTimeMs: 60,
      tokensUsed: 0,
      updatedAt: 160,
    });

    const finished = reduceGoalTurnFinished(paused, { now: 225 });

    expect(finished).toMatchObject({
      status: 'paused',
      revision: 4,
      evidenceCursor: { recordId: 'r-100' },
      turnCount: 3,
      activeTimeMs: 60,
      tokensUsed: 0,
      updatedAt: 225,
    });
  });

  it('accumulates per-turn token spend across finished turns', () => {
    let goal = goalRecord({ tokensUsed: 0 });

    goal = reduceGoalTurnFinished(goal, { now: 200, tokensUsed: 1_200 });
    goal = reduceGoalTurnFinished(goal, { now: 300, tokensUsed: 800 });

    expect(goal).toMatchObject({ turnCount: 2, tokensUsed: 2_000 });
  });

  it.each([
    ['a turn with no ledger entry', undefined],
    ['a negative reading', -50],
  ])('adds nothing for %s', (_label, tokensUsed) => {
    const finished = reduceGoalTurnFinished(goalRecord({ tokensUsed: 700 }), {
      now: 200,
      ...(tokensUsed === undefined ? {} : { tokensUsed }),
    });

    expect(finished).toMatchObject({ turnCount: 1, tokensUsed: 700 });
  });

  it('migrates a snapshot persisted before spend was recorded', () => {
    const goal = goalRecord();
    delete (goal as Partial<GoalRecord>).tokensUsed;

    expect(parseGoalSnapshotV2(snapshot(goal))).toMatchObject({
      goal: { tokensUsed: 0 },
    });
  });

  it('restores a persisted checkpoint stall streak and spells zero as no field', () => {
    const stalled = snapshot(goalRecord({ checkpointStalls: 2 }));
    expect(parseGoalSnapshotV2(stalled)).toEqual(stalled);
    expect(
      parseGoalSnapshotV2(snapshot(goalRecord({ checkpointStalls: 0 })))?.goal,
    ).not.toHaveProperty('checkpointStalls');
    expect(
      parseGoalSnapshotV2(snapshot(goalRecord({ checkpointStalls: -1 }))),
    ).toBeUndefined();
    expect(
      parseGoalSnapshotV2(snapshot(goalRecord({ checkpointStalls: 1.5 }))),
    ).toBeUndefined();
  });

  it('resets the checkpoint stall streak on edit', () => {
    const edited = reduceGoalControl(goalRecord({ checkpointStalls: 2 }), {
      request: {
        action: 'edit',
        objective: 'deliver the rest',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      },
      now: 200,
      nextGoalId: 'g-next',
      cursor: { recordId: 'r-200' },
    });
    expect(edited?.checkpointStalls).toBeUndefined();
  });

  it('rejects a snapshot carrying negative spend', () => {
    expect(
      parseGoalSnapshotV2(snapshot(goalRecord({ tokensUsed: -1 }))),
    ).toBeUndefined();
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

  it('parses clear snapshots with their cleared goal order', () => {
    const value = {
      v: 2,
      goal: null,
      activity: 'idle',
      clearedGoal: { goalId: 'g-1', revision: 3, updatedAt: 42 },
    } as const;

    expect(parseGoalSnapshotV2(value)).toEqual(value);
    expect(
      parseGoalSnapshotV2({
        ...value,
        clearedGoal: { ...value.clearedGoal, revision: 0 },
      }),
    ).toBeUndefined();
  });

  it.each(['evidence_catalog', 'checkpoint_request'] as const)(
    'round-trips a %s limitKind through a persisted snapshot',
    (limitKind) => {
      const value = snapshot(
        goalRecord({ status: 'usage_limited', limitKind }),
      );

      expect(parseGoalSnapshotV2(value)).toEqual(value);
    },
  );

  it('rejects a snapshot carrying an unknown limitKind', () => {
    const value = snapshot(
      goalRecord({
        status: 'usage_limited',
        limitKind: 'something_else' as never,
      }),
    );

    expect(parseGoalSnapshotV2(value)).toBeUndefined();
  });

  it.each(['active', 'paused', 'blocked', 'complete'] as const)(
    'rejects a %s snapshot carrying a limitKind',
    (status) => {
      const value = snapshot(
        goalRecord({ status, limitKind: 'evidence_catalog' }),
      );

      expect(parseGoalSnapshotV2(value)).toBeUndefined();
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

  it('parses and clones a persisted evidence checkpoint', () => {
    const evidenceCheckpoint = {
      checkpointId: 'checkpoint-1',
      createdAt: 42,
      claims: [
        {
          id: 'checkpoint-1:1',
          proofKind: 'external_fact' as const,
          claim: 'The focused suite passed.',
          sourceRefs: ['tool-1'],
        },
      ],
    };
    const parsed = parseGoalStateRecordPayloadV2({
      v: 2,
      cause: 'checkpoint',
      snapshot: snapshot(
        goalRecord({
          evidenceCursor: { recordId: 'checkpoint-1' },
          evidenceCheckpoint,
        }),
      ),
    });

    expect(parsed?.snapshot.goal?.evidenceCheckpoint).toEqual(
      evidenceCheckpoint,
    );
    expect(parsed?.snapshot.goal?.evidenceCheckpoint).not.toBe(
      evidenceCheckpoint,
    );
  });

  it('parses a persisted evidence checkpoint without a Buffer global', () => {
    // Browser hosts bundling the goalWire subpath have no Buffer global, so
    // the checkpoint byte count must rely on TextEncoder alone.
    const buffer = globalThis.Buffer;
    (globalThis as { Buffer?: unknown }).Buffer = undefined;
    try {
      const evidenceCheckpoint = {
        checkpointId: 'checkpoint-1',
        createdAt: 42,
        claims: [
          {
            id: 'checkpoint-1:1',
            proofKind: 'external_fact' as const,
            claim: 'The focused suite passed \u2713 18 tests',
            sourceRefs: ['tool-1'],
          },
        ],
      };
      const parsed = parseGoalStateRecordPayloadV2({
        v: 2,
        cause: 'checkpoint',
        snapshot: snapshot(
          goalRecord({
            evidenceCursor: { recordId: 'checkpoint-1' },
            evidenceCheckpoint,
          }),
        ),
      });
      expect(parsed?.snapshot.goal?.evidenceCheckpoint).toEqual(
        evidenceCheckpoint,
      );
    } finally {
      globalThis.Buffer = buffer;
    }
  });

  it('rejects persisted checkpoint claims without Core-owned sequential IDs', () => {
    expect(
      parseGoalStateRecordPayloadV2({
        v: 2,
        cause: 'checkpoint',
        snapshot: snapshot(
          goalRecord({
            evidenceCursor: { recordId: 'checkpoint-1' },
            evidenceCheckpoint: {
              checkpointId: 'checkpoint-1',
              createdAt: 42,
              claims: [
                {
                  id: 'checkpoint-1:custom',
                  proofKind: 'external_fact',
                  claim: 'The focused suite passed.',
                  sourceRefs: ['tool-1'],
                },
              ],
            },
          }),
        ),
      }),
    ).toBeUndefined();
  });

  it('parses and clones a durable pending checkpoint', () => {
    const checkpointPending = {
      permit: { goalId: 'g-1', revision: 1, turnId: 'turn-1' },
      recordUuid: 'checkpoint-1',
    };
    const parsed = parseGoalStateRecordPayloadV2({
      v: 2,
      cause: 'turn_finished',
      snapshot: snapshot(goalRecord()),
      checkpointPending,
    });

    expect(parsed?.checkpointPending).toEqual(checkpointPending);
    expect(parsed?.checkpointPending).not.toBe(checkpointPending);
  });

  it('parses a pending checkpoint persisted after a verifier rejection', () => {
    const checkpointPending = {
      permit: { goalId: 'g-1', revision: 1, turnId: 'turn-1' },
      recordUuid: 'checkpoint-1',
    };
    const parsed = parseGoalStateRecordPayloadV2({
      v: 2,
      cause: 'verifier_reject',
      snapshot: snapshot(goalRecord()),
      checkpointPending,
    });

    expect(parsed?.checkpointPending).toEqual(checkpointPending);
    expect(parsed?.checkpointPending).not.toBe(checkpointPending);
  });

  it.each([
    [
      'a mismatched Goal',
      'turn_finished',
      snapshot(goalRecord()),
      {
        permit: { goalId: 'other', revision: 1, turnId: 'turn-1' },
        recordUuid: 'checkpoint-1',
      },
    ],
    [
      'a mismatched revision',
      'turn_finished',
      snapshot(goalRecord()),
      {
        permit: { goalId: 'g-1', revision: 2, turnId: 'turn-1' },
        recordUuid: 'checkpoint-1',
      },
    ],
    [
      'an unsupported cause',
      'checkpoint',
      snapshot(goalRecord()),
      {
        permit: { goalId: 'g-1', revision: 1, turnId: 'turn-1' },
        recordUuid: 'checkpoint-1',
      },
    ],
    [
      'a stopped Goal',
      'turn_finished',
      snapshot(goalRecord({ status: 'paused' })),
      {
        permit: { goalId: 'g-1', revision: 1, turnId: 'turn-1' },
        recordUuid: 'checkpoint-1',
      },
    ],
    [
      'an empty checkpoint ID',
      'turn_finished',
      snapshot(goalRecord()),
      {
        permit: { goalId: 'g-1', revision: 1, turnId: 'turn-1' },
        recordUuid: '',
      },
    ],
    [
      'the current evidence cursor as its checkpoint ID',
      'turn_finished',
      snapshot(goalRecord()),
      {
        permit: { goalId: 'g-1', revision: 1, turnId: 'turn-1' },
        recordUuid: 'r-100',
      },
    ],
  ])(
    'rejects a pending checkpoint with %s',
    (_label, cause, goalSnapshot, checkpointPending) => {
      expect(
        parseGoalStateRecordPayloadV2({
          v: 2,
          cause,
          snapshot: goalSnapshot,
          checkpointPending,
        }),
      ).toBeUndefined();
    },
  );
});

describe('token budget transitions', () => {
  const control = (request: GoalControlRequest, tokenBudgetGrant?: number) => ({
    request,
    now: 200,
    nextGoalId: 'g-next',
    cursor: { recordId: 'r-200' },
    ...(tokenBudgetGrant === undefined ? {} : { tokenBudgetGrant }),
  });

  const budgetStopped = (overrides: Partial<GoalRecord> = {}): GoalRecord =>
    goalRecord({
      status: 'usage_limited',
      tokensUsed: 1_200,
      tokenBudget: 1_000,
      lastReason: goalTokenBudgetReason(1_000),
      limitKind: 'token_budget',
      ...overrides,
    });

  it('stamps the armed grant on create and replace', () => {
    const created = reduceGoalControl(
      null,
      control({ action: 'create', objective: 'ship' }, 1_000),
    );
    expect(created).toMatchObject({ tokenBudget: 1_000, tokensUsed: 0 });

    const replaced = reduceGoalControl(
      goalRecord({ tokensUsed: 900, tokenBudget: 1_000 }),
      control(
        {
          action: 'replace',
          objective: 'ship again',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        2_000,
      ),
    );
    expect(replaced).toMatchObject({ tokenBudget: 2_000, tokensUsed: 0 });
  });

  it('creates an unbounded Goal when no grant is armed', () => {
    const created = reduceGoalControl(
      null,
      control({ action: 'create', objective: 'ship' }),
    );
    expect(created).not.toHaveProperty('tokenBudget');
  });

  it('re-arms a budget-stopped Goal on resume: the ceiling moves ahead of the meter it never resets', () => {
    const resumed = reduceGoalControl(
      budgetStopped(),
      control(
        { action: 'resume', expectedGoalId: 'g-1', expectedRevision: 1 },
        1_000,
      ),
    );
    expect(resumed).toMatchObject({
      status: 'active',
      tokensUsed: 1_200,
      tokenBudget: 2_200,
      revision: 1,
      evidenceCursor: { recordId: 'r-100' },
    });
    expect(resumed?.lastReason).toBeUndefined();
    expect(resumed?.limitKind).toBeUndefined();
  });

  it('leaves an unspent ceiling alone on resume', () => {
    const resumed = reduceGoalControl(
      goalRecord({ status: 'paused', tokensUsed: 300, tokenBudget: 1_000 }),
      control(
        { action: 'resume', expectedGoalId: 'g-1', expectedRevision: 1 },
        1_000,
      ),
    );
    expect(resumed).toMatchObject({ status: 'active', tokenBudget: 1_000 });
  });

  it('re-arms when the spend lands exactly on the ceiling', () => {
    const resumed = reduceGoalControl(
      budgetStopped({ tokensUsed: 1_000, tokenBudget: 1_000 }),
      control(
        { action: 'resume', expectedGoalId: 'g-1', expectedRevision: 1 },
        1_000,
      ),
    );
    expect(resumed).toMatchObject({
      status: 'active',
      tokensUsed: 1_000,
      tokenBudget: 2_000,
    });
  });

  it.each(['paused', 'blocked'] as const)(
    're-arms a spent ceiling when resuming a %s Goal',
    (status) => {
      const resumed = reduceGoalControl(
        goalRecord({ status, tokensUsed: 1_200, tokenBudget: 1_000 }),
        control(
          { action: 'resume', expectedGoalId: 'g-1', expectedRevision: 1 },
          1_000,
        ),
      );
      expect(resumed).toMatchObject({
        status: 'active',
        tokensUsed: 1_200,
        tokenBudget: 2_200,
      });
    },
  );

  it('clears a spent ceiling on resume or edit when the runtime opts out', () => {
    const resumed = reduceGoalControl(
      budgetStopped(),
      control(
        { action: 'resume', expectedGoalId: 'g-1', expectedRevision: 1 },
        Number.POSITIVE_INFINITY,
      ),
    );
    expect(resumed).toMatchObject({ status: 'active', tokensUsed: 1_200 });
    expect(resumed).not.toHaveProperty('tokenBudget');

    const edited = reduceGoalControl(
      budgetStopped(),
      control(
        {
          action: 'edit',
          objective: 'ship without a budget',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        Number.POSITIVE_INFINITY,
      ),
    );
    expect(edited).toMatchObject({
      status: 'usage_limited',
      objective: 'ship without a budget',
      tokensUsed: 1_200,
    });
    expect(edited).not.toHaveProperty('tokenBudget');
  });

  it('re-arms a spent ceiling on edit, so the edited Goal can actually run', () => {
    const edited = reduceGoalControl(
      budgetStopped(),
      control(
        {
          action: 'edit',
          objective: 'ship the rest',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        1_000,
      ),
    );
    expect(edited).toMatchObject({
      status: 'usage_limited',
      revision: 2,
      tokensUsed: 1_200,
      tokenBudget: 2_200,
    });
  });

  it('never retrofits a budget onto an unbounded Goal', () => {
    const edited = reduceGoalControl(
      goalRecord({ tokensUsed: 5_000_000 }),
      control(
        {
          action: 'edit',
          objective: 'keep going',
          expectedGoalId: 'g-1',
          expectedRevision: 1,
        },
        1_000,
      ),
    );
    expect(edited).not.toHaveProperty('tokenBudget');
  });

  it('resumes an evidence-limited Goal through the fresh window, re-arming a spent budget on the way', () => {
    const resumed = reduceGoalControl(
      goalRecord({
        status: 'usage_limited',
        tokensUsed: 1_200,
        tokenBudget: 1_000,
        lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
        limitKind: 'evidence_catalog',
      }),
      control(
        { action: 'resume', expectedGoalId: 'g-1', expectedRevision: 1 },
        1_000,
      ),
    );
    expect(resumed).toMatchObject({
      status: 'active',
      tokensUsed: 1_200,
      tokenBudget: 2_200,
      evidenceCursor: { recordId: 'r-200' },
    });
    expect(resumed?.lastReason).toBeUndefined();
    expect(resumed?.limitKind).toBeUndefined();
  });

  it('restores a persisted budget and rejects a malformed one', () => {
    const stored = snapshot(
      goalRecord({
        status: 'usage_limited',
        tokensUsed: 1_200,
        tokenBudget: 1_000,
        lastReason: goalTokenBudgetReason(1_000),
        limitKind: 'token_budget',
      }),
    );
    expect(parseGoalSnapshotV2(stored)).toEqual(stored);
    expect(
      parseGoalSnapshotV2(snapshot(goalRecord({ tokenBudget: -1 }))),
    ).toBeUndefined();
    // A Goal from before budgets existed restores unbounded, not defaulted.
    expect(parseGoalSnapshotV2(snapshot(goalRecord()))).toEqual(
      snapshot(goalRecord()),
    );
  });
});

describe('budget wind-down marker', () => {
  const control = (request: GoalControlRequest, tokenBudgetGrant?: number) => ({
    request,
    now: 200,
    nextGoalId: 'g-next',
    cursor: { recordId: 'r-200' },
    ...(tokenBudgetGrant === undefined ? {} : { tokenBudgetGrant }),
  });

  it('is stamped by the turn that finished the hand-off, and by no other turn', () => {
    const quiet = reduceGoalTurnFinished(goalRecord(), {
      now: 200,
      tokensUsed: 10,
    });
    expect(quiet).not.toHaveProperty('windDownTurnId');

    const handedOff = reduceGoalTurnFinished(goalRecord(), {
      now: 200,
      tokensUsed: 10,
      windDownTurnId: 'turn-9',
    });
    expect(handedOff).toMatchObject({ windDownTurnId: 'turn-9', turnCount: 1 });
  });

  it.each(['resume', 'edit'] as const)(
    'is cleared when %s re-arms a spent budget',
    (action) => {
      const spent = goalRecord({
        status: 'usage_limited',
        limitKind: 'token_budget',
        tokensUsed: 1_200,
        tokenBudget: 1_000,
        windDownTurnId: 'turn-9',
      });
      const request: GoalControlRequest =
        action === 'resume'
          ? { action, expectedGoalId: 'g-1', expectedRevision: 1 }
          : {
              action,
              objective: 'ship the rest',
              expectedGoalId: 'g-1',
              expectedRevision: 1,
            };
      const next = reduceGoalControl(spent, control(request, 1_000));
      expect(next).toMatchObject({ tokenBudget: 2_200 });
      expect(next).not.toHaveProperty('windDownTurnId');
    },
  );

  it('survives a resume that does not re-arm anything', () => {
    // A paused Goal comes back to the same window; the hand-off it already
    // delivered there is still the truth about that window.
    const resumed = reduceGoalControl(
      goalRecord({
        status: 'paused',
        tokensUsed: 300,
        tokenBudget: 1_000,
        windDownTurnId: 'turn-9',
      }),
      control(
        { action: 'resume', expectedGoalId: 'g-1', expectedRevision: 1 },
        1_000,
      ),
    );
    expect(resumed).toMatchObject({
      status: 'active',
      windDownTurnId: 'turn-9',
    });
  });

  it('round-trips through a persisted snapshot and rejects an empty marker', () => {
    const stored = snapshot(
      goalRecord({
        tokensUsed: 1_500,
        tokenBudget: 1_000,
        windDownTurnId: 'turn-9',
      }),
    );
    expect(parseGoalSnapshotV2(stored)).toEqual(stored);
    expect(
      parseGoalSnapshotV2(snapshot(goalRecord({ windDownTurnId: '' }))),
    ).toBeUndefined();
    expect(
      parseGoalSnapshotV2(snapshot(goalRecord({ windDownTurnId: 7 as never }))),
    ).toBeUndefined();
  });
});
