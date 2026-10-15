/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  goalActiveTimeBudgetReason,
  goalLimitKindForReason,
  goalTokenBudgetReason,
  goalTurnBudgetReason,
  isGoalActiveTimeBudgetSpent,
  isGoalTurnBudgetSpent,
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
  reduceGoalSpend,
  reduceGoalTurnFinished,
  type GoalControlTransition,
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

/** Parses the snapshot of a `goalRecord(overrides)`. */
const parseRecord = (overrides: Partial<GoalRecord>) =>
  parseGoalSnapshotV2(snapshot(goalRecord(overrides)));

type Request<A> = Extract<GoalControlRequest, { action: A }>;
const create = (objective: string): Request<'create'> => ({
  action: 'create',
  objective,
});
// Versioned requests against g-1.
const pause = (reason?: string): Request<'pause'> => ({
  action: 'pause',
  expectedGoalId: 'g-1',
  expectedRevision: 1,
  ...(reason === undefined ? {} : { reason }),
});
const resume = (expectedRevision = 1): Request<'resume'> => ({
  action: 'resume',
  expectedGoalId: 'g-1',
  expectedRevision,
});
const edit = (objective: string, expectedRevision = 1): Request<'edit'> => ({
  action: 'edit',
  objective,
  expectedGoalId: 'g-1',
  expectedRevision,
});
const replace = (objective: string): Request<'replace'> => ({
  action: 'replace',
  objective,
  expectedGoalId: 'g-1',
  expectedRevision: 1,
});

/** Applies `request` at `now`, with the cursor at `r-<now>`. */
const control = (
  current: GoalRecord | null,
  request: GoalControlRequest,
  now = 200,
  nextGoalId = 'unused',
) =>
  reduceGoalControl(current, {
    request,
    now,
    nextGoalId,
    cursor: { recordId: `r-${now}` },
  });

/** Applies `request` at 200 (cursor r-200, next id g-next), arming `grants`. */
const arm = (
  current: GoalRecord | null,
  request: GoalControlRequest,
  grants: Pick<
    GoalControlTransition,
    'tokenBudgetGrant' | 'turnBudgetGrant' | 'activeTimeBudgetGrantMs'
  > = {},
) =>
  reduceGoalControl(current, {
    request,
    now: 200,
    nextGoalId: 'g-next',
    cursor: { recordId: 'r-200' },
    ...grants,
  });

describe('goal reducer', () => {
  it('replaces the same objective with a fresh identity and cursor', () => {
    const previous = goalRecord({ goalId: 'g-1', objective: 'ship' });
    const next = control(previous, replace('ship'), 200, 'g-2');

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
    const next = control(previous, edit('new objective', 4), 300);

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
    const next = control(previous, edit('updated objective', 2), 300);

    expect(next?.lastReason).toBeUndefined();
    expect(next?.objective).toBe('updated objective');
  });

  it('creates a trimmed active goal only when no goal exists', () => {
    const next = control(null, create('  ship  '), 100, 'g-1');

    expect(next).toEqual(goalRecord());
    expect(() => control(next, create('another'), 200, 'g-2')).toThrow(
      GoalConflictError,
    );
  });

  it('rejects empty objectives', () => {
    expect(() => control(null, create(' \n '), 100, 'g-1')).toThrow(
      GoalInvalidTransitionError,
    );
  });

  it('returns the current snapshot for stale identity and revision', () => {
    const previous = goalRecord({ revision: 4 });

    for (const request of [
      { ...pause(), expectedGoalId: 'g-other', expectedRevision: 4 },
      { ...pause(), expectedRevision: 3 },
    ]) {
      try {
        control(previous, request);
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
    const paused = control(
      goalRecord({ lastReason: 'the verifier wanted the test output pasted' }),
      pause(GOAL_PAUSE_REASON_USER_INTERRUPT),
      150,
    );

    expect(paused?.status).toBe('paused');
    expect(paused?.lastReason).toBe(GOAL_PAUSE_REASON_USER_INTERRUPT);
  });

  it('clears a stale reason when a pause supplies none', () => {
    // The value it would otherwise keep is the previous turn's verifier
    // rejection, which explains why the Goal was still running rather than
    // why it stopped -- so a reasonless pause must not inherit it.
    const paused = control(
      goalRecord({ lastReason: 'the verifier wanted the test output pasted' }),
      pause(),
      150,
    );

    expect(paused?.status).toBe('paused');
    expect(paused?.lastReason).toBeUndefined();
  });

  it('parses a pause reason, and rejects one that is empty, oversized, or misplaced', () => {
    expect(parseGoalControlRequest(pause(GOAL_PAUSE_REASON_COMMAND))).toEqual({
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
      expect(parseGoalControlRequest({ ...pause(), reason })).toBeUndefined();
    }

    // Only a pause carries one: resume and clear stay exact-key requests.
    for (const action of ['resume', 'clear'] as const) {
      expect(
        parseGoalControlRequest({
          ...pause(GOAL_PAUSE_REASON_COMMAND),
          action,
        }),
      ).toBeUndefined();
    }
  });

  it('pauses and resumes without changing revision or evidence cursor', () => {
    const paused = control(goalRecord(), pause(), 150);
    const resumed = control(paused, resume());

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
    const paused = control(
      goalRecord(),
      pause(GOAL_PAUSE_REASON_USER_INTERRUPT),
      150,
    );
    expect(paused?.lastReason).toBe(GOAL_PAUSE_REASON_USER_INTERRUPT);

    const resumed = control(paused, resume());

    expect(resumed?.status).toBe('active');
    expect(resumed?.lastReason).toBeUndefined();
  });

  it("keeps a blocked goal's reason when it resumes", () => {
    const resumed = control(
      goalRecord({ status: 'blocked', lastReason: 'Waiting on a credential.' }),
      resume(),
    );

    expect(resumed?.status).toBe('active');
    expect(resumed?.lastReason).toBe('Waiting on a credential.');
  });

  it('rejects resuming an already-active goal', () => {
    expect(() => control(goalRecord(), resume())).toThrow(
      GoalInvalidTransitionError,
    );
  });

  it.each(['blocked', 'usage_limited'] as const)(
    'resumes a %s goal without changing revision or evidence cursor',
    (status) => {
      const resumed = control(goalRecord({ status, revision: 4 }), resume(4));

      expect(resumed).toMatchObject({
        status: 'active',
        revision: 4,
        evidenceCursor: { recordId: 'r-100' },
      });
    },
  );

  it('preserves the cumulative turn count when resuming a limited goal', () => {
    const resumed = control(
      goalRecord({
        status: 'usage_limited',
        revision: 4,
        turnCount: FORMER_GOAL_CONTINUATION_LIMIT,
      }),
      resume(4),
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
      const resumed = control(
        goalRecord({
          status: 'usage_limited',
          revision: 4,
          limitKind,
          lastReason: 'a reason the guard no longer has to recognise',
        }),
        resume(4),
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
      expect(resumed?.limitKind).toBeUndefined();
      expect(resumed?.lastReason).toBeUndefined();
    },
  );

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
      const resumed = control(
        goalRecord({ status: 'usage_limited', revision: 4, lastReason }),
        resume(4),
      );

      expect(resumed).toMatchObject({
        status: 'active',
        evidenceCursor: { recordId: 'r-200' },
      });
      expect(resumed?.lastReason).toBeUndefined();
    },
  );

  it('keeps the window of an operationally limited Goal when it resumes', () => {
    // Only the legacy evidence bounds reset the window. A `usage_limited`
    // Goal stopped by an operational failure keeps its cursor, so a resume
    // does not move the window past records it never had a problem with.
    const resumed = control(
      goalRecord({
        status: 'usage_limited',
        revision: 4,
        lastReason: 'Goal checkpoint recovery dependencies are unavailable',
      }),
      resume(4),
    );

    expect(resumed).toMatchObject({
      status: 'active',
      evidenceCursor: { recordId: 'r-100' },
    });
  });

  it('clears limitKind when the objective is edited', () => {
    const edited = control(
      goalRecord({
        status: 'usage_limited',
        revision: 4,
        limitKind: 'evidence_catalog',
        lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
      }),
      edit('ship something else', 4),
    );

    expect(edited?.limitKind).toBeUndefined();
    expect(edited?.lastReason).toBeUndefined();
  });

  it('rejects an unsupported control action instead of resuming', () => {
    expect(() =>
      control(goalRecord({ status: 'paused' }), {
        action: 'archive',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      } as unknown as GoalControlRequest),
    ).toThrow(GoalInvalidTransitionError);
  });

  it.each(['paused', 'blocked', 'usage_limited'] as const)(
    'edits a %s goal without changing its status',
    (status) => {
      const next = control(
        goalRecord({ status, revision: 4 }),
        edit('new objective', 4),
        300,
      );

      expect(next).toMatchObject({ status, revision: 5 });
    },
  );

  it('rejects editing or resuming a completed goal', () => {
    const complete = goalRecord({ status: 'complete' });

    for (const request of [edit('new objective'), resume()]) {
      expect(() => control(complete, request)).toThrow(
        GoalInvalidTransitionError,
      );
    }
  });

  it('clears a matching goal', () => {
    expect(
      control(goalRecord(), {
        action: 'clear',
        expectedGoalId: 'g-1',
        expectedRevision: 1,
      }),
    ).toBeNull();
  });

  it('folds active elapsed time before each persisted transition', () => {
    const paused = control(goalRecord(), pause(), 160);
    const resumed = control(paused, resume(), 250);
    const pausedAgain = control(resumed, pause(), 275);

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

  it('rejects a snapshot carrying negative spend', () => {
    expect(parseRecord({ tokensUsed: -1 })).toBeUndefined();
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
    const payload = { v: 2, cause: 'create', snapshot: snapshot(record) };
    expect(parseGoalStateRecordPayloadV2(payload)).toEqual(payload);
    expect(
      parseGoalStateRecordPayloadV2({
        ...payload,
        snapshot: { ...snapshot(record), activity: 'running' },
      }),
    ).toBeUndefined();
    expect(parseGoalControlRequest(create('ship'))).toEqual(create('ship'));
    expect(parseGoalControlRequest(edit('  '))).toBeUndefined();
    expect(
      parseGoalControlRequest({ action: 'pause', expectedGoalId: 'g-1' }),
    ).toBeUndefined();
    expect(
      parseGoalControlRequest({ ...pause(), expectedRevision: 0 }),
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
    expect(
      parseRecord({
        status: 'usage_limited',
        limitKind: 'something_else' as never,
      }),
    ).toBeUndefined();
  });

  it.each(['active', 'paused', 'blocked', 'complete'] as const)(
    'rejects a %s snapshot carrying a limitKind',
    (status) => {
      expect(
        parseRecord({ status, limitKind: 'evidence_catalog' }),
      ).toBeUndefined();
    },
  );

  const auditPayload = (blockedAudit: object) => ({
    v: 2,
    cause: 'turn_finished',
    snapshot: snapshot(goalRecord()),
    blockedAudit,
  });

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
      parseGoalStateRecordPayloadV2(auditPayload(blockedAudit)),
    ).toBeUndefined();
  });

  it('parses and clones a valid blocked audit', () => {
    const blockedAudit = {
      fingerprint: 'same',
      count: 2,
      turnIds: ['turn-1', 'turn-2'],
    };
    const parsed = parseGoalStateRecordPayloadV2(auditPayload(blockedAudit));

    expect(parsed?.blockedAudit).toEqual(blockedAudit);
    expect(parsed?.blockedAudit).not.toBe(blockedAudit);
  });

  // A record as a build that still compressed evidence into checkpoints
  // journaled it. The parsers are closed-key allowlists, so dropping any of
  // these from them would reject the whole record, and a session resumed
  // after an upgrade would lose its Goal.
  const legacyCheckpointPayload = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    v: 2,
    cause: 'checkpoint',
    snapshot: {
      v: 2,
      activity: 'idle',
      goal: {
        ...goalRecord({ evidenceCursor: { recordId: 'checkpoint-1' } }),
        evidenceCheckpoint: {
          checkpointId: 'checkpoint-1',
          createdAt: 42,
          claims: [
            {
              id: 'checkpoint-1:1',
              proofKind: 'external_fact',
              claim: 'The focused suite passed \u2713 18 tests',
              sourceRefs: ['tool-1'],
            },
          ],
        },
        checkpointStalls: 2,
        lastCheckpointFailure: 'InvalidGoalCheckpointError: not JSON',
      },
    },
    ...overrides,
  });

  it('parses a record an earlier build journaled, and leaves its checkpoint state behind', () => {
    const parsed = parseGoalStateRecordPayloadV2(
      legacyCheckpointPayload({
        cause: 'turn_finished',
        checkpointPending: {
          permit: { goalId: 'g-1', revision: 1, turnId: 'turn-7' },
          recordUuid: 'pending-1',
        },
      }),
    );

    expect(parsed).toMatchObject({
      v: 2,
      cause: 'turn_finished',
      snapshot: {
        goal: { goalId: 'g-1', evidenceCursor: { recordId: 'checkpoint-1' } },
      },
    });
    expect(parsed).not.toHaveProperty('checkpointPending');
    expect(parsed!.snapshot.goal).not.toHaveProperty('evidenceCheckpoint');
    expect(parsed!.snapshot.goal).not.toHaveProperty('checkpointStalls');
    expect(parsed!.snapshot.goal).not.toHaveProperty('lastCheckpointFailure');
  });

  it('keeps the legacy cause and limit kinds parseable', () => {
    expect(
      parseGoalStateRecordPayloadV2(legacyCheckpointPayload())?.cause,
    ).toBe('checkpoint');
    for (const limitKind of ['evidence_catalog', 'checkpoint_request']) {
      const payload = legacyCheckpointPayload({ cause: 'usage_limited' });
      const goal = (payload['snapshot'] as { goal: Record<string, unknown> })
        .goal;
      goal['status'] = 'usage_limited';
      goal['limitKind'] = limitKind;
      expect(
        parseGoalStateRecordPayloadV2(payload)?.snapshot.goal?.limitKind,
      ).toBe(limitKind);
    }
  });

  it('still rejects a key it has never known', () => {
    expect(
      parseGoalStateRecordPayloadV2(legacyCheckpointPayload({ extra: true })),
    ).toBeUndefined();
    const payload = legacyCheckpointPayload();
    (payload['snapshot'] as { goal: Record<string, unknown> }).goal['extra'] =
      true;
    expect(parseGoalStateRecordPayloadV2(payload)).toBeUndefined();
  });

  it('parses a legacy record without a Buffer global', () => {
    // Browser hosts bundling the goalWire subpath have no Buffer global.
    const buffer = globalThis.Buffer;
    (globalThis as { Buffer?: unknown }).Buffer = undefined;
    try {
      expect(
        parseGoalStateRecordPayloadV2(legacyCheckpointPayload()),
      ).toBeDefined();
    } finally {
      globalThis.Buffer = buffer;
    }
  });
});

describe('token budget transitions', () => {
  const budgetStopped = (overrides: Partial<GoalRecord> = {}): GoalRecord =>
    goalRecord({
      status: 'usage_limited',
      tokensUsed: 1_200,
      tokenBudget: 1_000,
      lastReason: goalTokenBudgetReason(1_000),
      limitKind: 'token_budget',
      ...overrides,
    });
  const grant = { tokenBudgetGrant: 1_000 };

  it('stamps the armed grant on create and replace', () => {
    const created = arm(null, create('ship'), grant);
    expect(created).toMatchObject({ tokenBudget: 1_000, tokensUsed: 0 });

    const replaced = arm(
      goalRecord({ tokensUsed: 900, tokenBudget: 1_000 }),
      replace('ship again'),
      { tokenBudgetGrant: 2_000 },
    );
    expect(replaced).toMatchObject({ tokenBudget: 2_000, tokensUsed: 0 });
  });

  it('creates an unbounded Goal when no grant is armed', () => {
    const created = arm(null, create('ship'));
    expect(created).not.toHaveProperty('tokenBudget');
  });

  it('re-arms a budget-stopped Goal on resume: the ceiling moves ahead of the meter it never resets', () => {
    const resumed = arm(budgetStopped(), resume(), grant);
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
    const resumed = arm(
      goalRecord({ status: 'paused', tokensUsed: 300, tokenBudget: 1_000 }),
      resume(),
      grant,
    );
    expect(resumed).toMatchObject({ status: 'active', tokenBudget: 1_000 });
  });

  it('re-arms when the spend lands exactly on the ceiling', () => {
    const resumed = arm(
      budgetStopped({ tokensUsed: 1_000, tokenBudget: 1_000 }),
      resume(),
      grant,
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
      const resumed = arm(
        goalRecord({ status, tokensUsed: 1_200, tokenBudget: 1_000 }),
        resume(),
        grant,
      );
      expect(resumed).toMatchObject({
        status: 'active',
        tokensUsed: 1_200,
        tokenBudget: 2_200,
      });
    },
  );

  it('clears a spent ceiling on resume or edit when the runtime opts out', () => {
    const optOut = { tokenBudgetGrant: Number.POSITIVE_INFINITY };
    const resumed = arm(budgetStopped(), resume(), optOut);
    expect(resumed).toMatchObject({ status: 'active', tokensUsed: 1_200 });
    expect(resumed).not.toHaveProperty('tokenBudget');

    const edited = arm(budgetStopped(), edit('ship without a budget'), optOut);
    expect(edited).toMatchObject({
      status: 'usage_limited',
      objective: 'ship without a budget',
      tokensUsed: 1_200,
    });
    expect(edited).not.toHaveProperty('tokenBudget');
  });

  it('re-arms a spent ceiling on edit, so the edited Goal can actually run', () => {
    const edited = arm(budgetStopped(), edit('ship the rest'), grant);
    expect(edited).toMatchObject({
      status: 'usage_limited',
      revision: 2,
      tokensUsed: 1_200,
      tokenBudget: 2_200,
    });
  });

  it('never retrofits a budget onto an unbounded Goal', () => {
    const edited = arm(
      goalRecord({ tokensUsed: 5_000_000 }),
      edit('keep going'),
      grant,
    );
    expect(edited).not.toHaveProperty('tokenBudget');
  });

  it('resumes an evidence-limited Goal through the fresh window, re-arming a spent budget on the way', () => {
    const resumed = arm(
      goalRecord({
        status: 'usage_limited',
        tokensUsed: 1_200,
        tokenBudget: 1_000,
        lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
        limitKind: 'evidence_catalog',
      }),
      resume(),
      grant,
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
    const stored = snapshot(budgetStopped());
    expect(parseGoalSnapshotV2(stored)).toEqual(stored);
    expect(parseRecord({ tokenBudget: -1 })).toBeUndefined();
    // A Goal from before budgets existed restores unbounded, not defaulted.
    expect(parseGoalSnapshotV2(snapshot(goalRecord()))).toEqual(
      snapshot(goalRecord()),
    );
  });
});

describe('budget wind-down marker', () => {
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
      const request = action === 'resume' ? resume() : edit('ship the rest');
      const next = arm(spent, request, { tokenBudgetGrant: 1_000 });
      expect(next).toMatchObject({ tokenBudget: 2_200 });
      expect(next).not.toHaveProperty('windDownTurnId');
    },
  );

  it('survives a resume that does not re-arm anything', () => {
    // A paused Goal comes back to the same window; the hand-off it already
    // delivered there is still the truth about that window.
    const resumed = arm(
      goalRecord({
        status: 'paused',
        tokensUsed: 300,
        tokenBudget: 1_000,
        windDownTurnId: 'turn-9',
      }),
      resume(),
      { tokenBudgetGrant: 1_000 },
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
    expect(parseRecord({ windDownTurnId: '' })).toBeUndefined();
    expect(parseRecord({ windDownTurnId: 7 as never })).toBeUndefined();
  });
});

describe('no-progress streak', () => {
  it('records a streak a finished turn reports, and spells zero as no field', () => {
    const counted = reduceGoalTurnFinished(goalRecord(), {
      now: 200,
      noProgressTurns: 2,
    });
    expect(counted).toMatchObject({ turnCount: 1, noProgressTurns: 2 });

    const cleared = reduceGoalTurnFinished(counted, {
      now: 300,
      noProgressTurns: 0,
    });
    expect(cleared).not.toHaveProperty('noProgressTurns');
  });

  it('leaves the streak untouched when a finished turn reports none', () => {
    // The runtime reports nothing when it cannot tell a quiet turn from a
    // busy one. "Unmeasured" must not read as "idle" or as "made progress".
    const finished = reduceGoalTurnFinished(
      goalRecord({ noProgressTurns: 2 }),
      { now: 200 },
    );
    expect(finished).toMatchObject({ noProgressTurns: 2 });
  });

  it('clears the streak on edit', () => {
    const edited = arm(
      goalRecord({ noProgressTurns: 2 }),
      edit('deliver the rest'),
    );
    expect(edited).not.toHaveProperty('noProgressTurns');
  });

  it.each([
    ['paused', 'paused', undefined],
    ['budget-limited', 'usage_limited', 'token_budget'],
    ['evidence-limited', 'usage_limited', 'evidence_catalog'],
  ] as const)(
    'clears the streak when a %s Goal resumes',
    (_label, status, limitKind) => {
      // Resuming is the user asking for another run at the objective. Starting
      // that run three-quarters of the way to the bound would end it after a
      // single quiet turn.
      const state = { status, ...(limitKind ? { limitKind } : {}) };
      const resumed = arm(
        goalRecord({ ...state, noProgressTurns: 2 }),
        resume(),
      );

      expect(resumed).toMatchObject({ status: 'active' });
      expect(resumed).not.toHaveProperty('noProgressTurns');
    },
  );

  it('restores a persisted streak and rejects a malformed one', () => {
    const idling = snapshot(goalRecord({ noProgressTurns: 2 }));
    expect(parseGoalSnapshotV2(idling)).toEqual(idling);
    expect(parseRecord({ noProgressTurns: 0 })?.goal).not.toHaveProperty(
      'noProgressTurns',
    );
    expect(parseRecord({ noProgressTurns: -1 })).toBeUndefined();
    expect(parseRecord({ noProgressTurns: 1.5 })).toBeUndefined();
  });

  it('restores a Goal persisted before the streak existed', () => {
    const goal = goalRecord();
    expect(parseGoalSnapshotV2(snapshot(goal))?.goal).not.toHaveProperty(
      'noProgressTurns',
    );
  });
});

describe('turn and active-time budgets', () => {
  const turnStopped = (overrides: Partial<GoalRecord> = {}): GoalRecord =>
    goalRecord({
      status: 'usage_limited',
      turnCount: 20,
      turnBudget: 20,
      lastReason: goalTurnBudgetReason(20),
      limitKind: 'turn_budget',
      ...overrides,
    });

  const timeStopped = (overrides: Partial<GoalRecord> = {}): GoalRecord =>
    goalRecord({
      status: 'usage_limited',
      activeTimeMs: 1_800_000,
      activeTimeBudgetMs: 1_800_000,
      lastReason: goalActiveTimeBudgetReason(1_800_000),
      limitKind: 'time_budget',
      ...overrides,
    });

  it('counts a budget as spent the moment the meter reaches it', () => {
    // The ceiling is absolute, so equality is already spent -- the same rule
    // `isGoalTokenBudgetSpent` uses, and what makes the re-arm well defined.
    expect(isGoalTurnBudgetSpent({ turnCount: 19, turnBudget: 20 })).toBe(
      false,
    );
    expect(isGoalTurnBudgetSpent({ turnCount: 20, turnBudget: 20 })).toBe(true);
    expect(isGoalTurnBudgetSpent({ turnCount: 99 })).toBe(false);

    expect(
      isGoalActiveTimeBudgetSpent({ activeTimeBudgetMs: 60_000 }, 59_999),
    ).toBe(false);
    expect(
      isGoalActiveTimeBudgetSpent({ activeTimeBudgetMs: 60_000 }, 60_000),
    ).toBe(true);
    expect(isGoalActiveTimeBudgetSpent({}, 10 ** 9)).toBe(false);
  });

  it('stamps the armed grants on create and replace', () => {
    const created = arm(null, create('ship'), {
      turnBudgetGrant: 20,
      activeTimeBudgetGrantMs: 1_800_000,
    });
    expect(created).toMatchObject({
      turnBudget: 20,
      activeTimeBudgetMs: 1_800_000,
      turnCount: 0,
      activeTimeMs: 0,
    });

    const replaced = arm(
      turnStopped({
        status: 'active',
        lastReason: undefined,
        limitKind: undefined,
      }),
      replace('ship again'),
      { turnBudgetGrant: 5 },
    );
    // A replacement is a new Goal: its meter starts at zero, so the ceiling is
    // the grant itself rather than the old count plus the grant.
    expect(replaced).toMatchObject({ turnBudget: 5, turnCount: 0 });
  });

  it('creates an unbounded Goal when no cadence grant is armed', () => {
    const created = arm(null, create('ship'));
    expect(created).not.toHaveProperty('turnBudget');
    expect(created).not.toHaveProperty('activeTimeBudgetMs');
  });

  it('arms nothing for a non-finite grant, since Infinity cannot be journalled', () => {
    const created = arm(null, create('ship'), {
      turnBudgetGrant: Number.POSITIVE_INFINITY,
      activeTimeBudgetGrantMs: Number.POSITIVE_INFINITY,
    });
    expect(created).not.toHaveProperty('turnBudget');
    expect(created).not.toHaveProperty('activeTimeBudgetMs');
  });

  it('re-arms a turn-stopped Goal on resume, moving the ceiling ahead of the count', () => {
    const resumed = arm(turnStopped(), resume(), { turnBudgetGrant: 20 });

    expect(resumed).toMatchObject({
      status: 'active',
      turnCount: 20,
      turnBudget: 40,
    });
    // The stop prose and the kind belong to the window that ended. Both are
    // spread as `undefined` rather than deleted, so assert the value.
    expect(resumed?.lastReason).toBeUndefined();
    expect(resumed?.limitKind).toBeUndefined();
  });

  it('re-arms a time-stopped Goal on resume, from the elapsed time it stopped at', () => {
    const resumed = arm(timeStopped(), resume(), {
      activeTimeBudgetGrantMs: 600_000,
    });

    expect(resumed).toMatchObject({
      status: 'active',
      activeTimeMs: 1_800_000,
      activeTimeBudgetMs: 2_400_000,
    });
    expect(resumed?.lastReason).toBeUndefined();
    expect(resumed?.limitKind).toBeUndefined();
  });

  it('clears the stop prose for every budget kind, not just the token one', () => {
    // The resume branch keys off `isGoalBudgetLimitKind`. Keyed off
    // `token_budget` alone, a cadence-stopped Goal would resume still
    // rendering "ran its turn budget" as the reason it is active.
    for (const stopped of [turnStopped(), timeStopped()]) {
      const resumed = arm(stopped, resume());
      expect(resumed).toMatchObject({ status: 'active' });
      expect(resumed?.lastReason).toBeUndefined();
      expect(resumed?.limitKind).toBeUndefined();
    }
  });

  it('re-arms a spent cadence ceiling on edit', () => {
    const edited = arm(turnStopped(), edit('deliver the rest'), {
      turnBudgetGrant: 3,
    });
    expect(edited).toMatchObject({ status: 'usage_limited', turnBudget: 23 });
  });

  it('leaves an unspent ceiling exactly where it was', () => {
    const resumed = arm(
      goalRecord({
        status: 'paused',
        turnCount: 4,
        turnBudget: 20,
        activeTimeMs: 60_000,
        activeTimeBudgetMs: 1_800_000,
      }),
      resume(),
      { turnBudgetGrant: 20, activeTimeBudgetGrantMs: 600_000 },
    );
    expect(resumed).toMatchObject({
      turnBudget: 20,
      activeTimeBudgetMs: 1_800_000,
    });
  });

  it('never retrofits a cadence ceiling onto a Goal that has none', () => {
    const resumed = arm(
      goalRecord({ status: 'paused', turnCount: 40, activeTimeMs: 10 ** 7 }),
      resume(),
      { turnBudgetGrant: 5, activeTimeBudgetGrantMs: 1_000 },
    );
    expect(resumed).not.toHaveProperty('turnBudget');
    expect(resumed).not.toHaveProperty('activeTimeBudgetMs');
  });

  it('re-arms only the ceilings that were actually spent', () => {
    // A resume granted because the turns ran out must not quietly widen a
    // token window the Goal had barely touched.
    const resumed = arm(
      turnStopped({ tokensUsed: 10, tokenBudget: 1_000 }),
      resume(),
      { tokenBudgetGrant: 5_000, turnBudgetGrant: 20 },
    );
    expect(resumed).toMatchObject({ tokenBudget: 1_000, turnBudget: 40 });
  });

  it('drops the wind-down marker when a cadence ceiling is re-armed', () => {
    const resumed = arm(
      turnStopped({ windDownTurnId: 'turn-handoff' }),
      resume(),
      { turnBudgetGrant: 20 },
    );
    expect(resumed).not.toHaveProperty('windDownTurnId');
  });

  it('removes a cadence ceiling the resume opts out of, leaving no undefined key behind', () => {
    const turnResumed = arm(turnStopped(), resume(), {
      turnBudgetGrant: Number.POSITIVE_INFINITY,
    });
    expect(turnResumed).toMatchObject({ status: 'active' });
    expect(Object.keys(turnResumed!)).not.toContain('turnBudget');

    const timeResumed = arm(timeStopped(), resume(), {
      activeTimeBudgetGrantMs: Number.POSITIVE_INFINITY,
    });
    expect(timeResumed).toMatchObject({ status: 'active' });
    expect(Object.keys(timeResumed!)).not.toContain('activeTimeBudgetMs');
  });

  it('re-arms a spent cadence ceiling on the way through an evidence resume', () => {
    const resumed = arm(
      turnStopped({
        lastReason: GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
        limitKind: 'evidence_catalog',
      }),
      resume(),
      { turnBudgetGrant: 20 },
    );
    expect(resumed).toMatchObject({
      status: 'active',
      evidenceCursor: { recordId: 'r-200' },
      turnBudget: 40,
    });
  });

  it('round-trips the cadence ceilings and their limit kinds through a snapshot', () => {
    const stopped = snapshot(turnStopped({ activeTimeBudgetMs: 1_800_000 }));
    expect(parseGoalSnapshotV2(stopped)).toEqual(stopped);

    const timed = snapshot(timeStopped());
    expect(parseGoalSnapshotV2(timed)).toEqual(timed);
  });

  it('rejects a malformed cadence ceiling', () => {
    expect(parseRecord({ turnBudget: -1 })).toBeUndefined();
    expect(parseRecord({ turnBudget: 1.5 })).toBeUndefined();
    expect(parseRecord({ activeTimeBudgetMs: -1 })).toBeUndefined();
  });

  it('restores a Goal persisted before the cadence ceilings existed', () => {
    const goal = goalRecord();
    const parsed = parseGoalSnapshotV2(snapshot(goal))?.goal;
    expect(parsed).not.toHaveProperty('turnBudget');
    expect(parsed).not.toHaveProperty('activeTimeBudgetMs');
  });

  it('keeps the elapsed clock the re-arm is measured against', () => {
    // `transitionGoal` commits `elapsedActiveTime` on every transition, and the
    // time ceiling is re-armed from that same figure -- so a Goal that stopped
    // after 30 active minutes resumes with a window starting there, not at a
    // wall clock the record never held.
    const stopped = timeStopped();
    expect(elapsedActiveTime(stopped, 10 ** 9)).toBe(1_800_000);
  });

  it('re-arms an active time ceiling from elapsed time on edit', () => {
    const edited = arm(
      goalRecord({
        status: 'active',
        activeTimeMs: 1_799_900,
        activeTimeBudgetMs: 1_800_000,
        updatedAt: 0,
      }),
      edit('deliver the rest'),
      { activeTimeBudgetGrantMs: 600_000 },
    );

    expect(edited).toMatchObject({
      status: 'active',
      activeTimeMs: 1_800_100,
      activeTimeBudgetMs: 2_400_100,
    });
  });
});

describe('reduceGoalSpend', () => {
  it.each(['active', 'paused'] as const)(
    'adds model spend without losing elapsed time for a %s Goal',
    (status) => {
      const goal = goalRecord({
        status,
        tokensUsed: 10,
        turnCount: 2,
        activeTimeMs: 500,
      });
      expect(reduceGoalSpend(goal, 30, 1_000)).toEqual({
        ...goal,
        tokensUsed: 40,
        activeTimeMs: status === 'active' ? 1_400 : 500,
        updatedAt: 1_000,
      });
      expect(goal).toMatchObject({
        tokensUsed: 10,
        activeTimeMs: 500,
        updatedAt: 100,
      });
    },
  );
  it.each([0, -1, NaN, Infinity])('ignores unusable spend %s', (tokens) => {
    const goal = goalRecord();
    expect(reduceGoalSpend(goal, tokens, 99)).toBe(goal);
  });
});
