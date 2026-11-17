/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type {
  GoalRecord,
  GoalStateCause,
  GoalStateRecordPayloadV2,
} from './goal-protocol.js';
import { projectGoalCard } from './goal-card.js';

const GOAL: GoalRecord = {
  goalId: 'goal-1',
  revision: 2,
  objective: 'ship it',
  status: 'active',
  evidenceCursor: { recordId: 'state-1' },
  turnCount: 4,
  activeTimeMs: 2000,
  tokensUsed: 0,
  createdAt: 100,
  updatedAt: 200,
  lastReason: 'continuing',
};

function payload(
  cause: GoalStateCause,
  status: GoalRecord['status'] = 'active',
  goal: GoalRecord | null = { ...GOAL, status },
): GoalStateRecordPayloadV2 {
  return {
    v: 2,
    cause,
    snapshot: { v: 2, activity: 'idle', goal },
  };
}

describe('projectGoalCard', () => {
  it.each(['create', 'replace', 'edit', 'resume'] as const)(
    'shows %s as a set card with the Goal fields',
    (cause) => {
      expect(projectGoalCard(payload(cause))).toEqual({
        kind: 'set',
        condition: 'ship it',
        iterations: 4,
        setAt: 100,
        durationMs: 2000,
        lastReason: 'continuing',
      });
    },
  );

  it('shows completion as achieved', () => {
    expect(projectGoalCard(payload('complete', 'complete'))).toMatchObject({
      kind: 'achieved',
      condition: 'ship it',
      iterations: 4,
      durationMs: 2000,
    });
  });

  it('shows clear as cleared, named after the Goal it cleared', () => {
    expect(
      projectGoalCard(payload('clear', 'active', null), GOAL),
    ).toMatchObject({
      kind: 'cleared',
      condition: 'ship it',
    });
  });

  it('shows clear with no prior Goal as an unnamed cleared card', () => {
    expect(projectGoalCard(payload('clear', 'active', null))).toEqual({
      kind: 'cleared',
      condition: '',
    });
  });

  it('shows pause as paused', () => {
    expect(projectGoalCard(payload('pause', 'paused')).kind).toBe('paused');
  });

  it('shows a migrated Goal as paused, not as a re-asserted active one', () => {
    // Builds between #7895 and #12155 only ever persisted `migrated` with
    // `status: 'paused'`, and a paused Goal drives no turns.
    expect(projectGoalCard(payload('migrated', 'paused')).kind).toBe('paused');
  });

  it.each(['blocked', 'usage_limited'] as const)(
    'shows %s as aborted',
    (status) => {
      expect(projectGoalCard(payload(status, status))).toMatchObject({
        kind: 'aborted',
        condition: 'ship it',
      });
    },
  );

  it('shows runtime progress as checking', () => {
    expect(projectGoalCard(payload('turn_finished', 'active')).kind).toBe(
      'checking',
    );
    expect(projectGoalCard(payload('checkpoint', 'active')).kind).toBe(
      'checking',
    );
  });

  it('shows a turn that finished on a stopped Goal by the Goal status', () => {
    expect(projectGoalCard(payload('turn_finished', 'paused')).kind).toBe(
      'checking',
    );
    expect(projectGoalCard(payload('turn_finished', 'complete')).kind).toBe(
      'achieved',
    );
    expect(projectGoalCard(payload('verifier_reject', 'blocked')).kind).toBe(
      'aborted',
    );
  });
});
