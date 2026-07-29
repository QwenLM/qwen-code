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
import { projectGoalStateToLegacy } from './goal-legacy-projection.js';

const GOAL: GoalRecord = {
  goalId: 'goal-1',
  revision: 2,
  objective: 'ship it',
  status: 'active',
  evidenceCursor: { recordId: 'state-1' },
  turnCount: 4,
  activeTimeMs: 2000,
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

describe('projectGoalStateToLegacy', () => {
  it.each(['create', 'replace', 'edit', 'resume', 'migrated'] as const)(
    'projects %s as legacy set with an active projection',
    (cause) => {
      const projected = projectGoalStateToLegacy(payload(cause));

      expect(projected.goalStatus.kind).toBe('set');
      expect(projected.activeGoal).toMatchObject({
        condition: 'ship it',
        iterations: 4,
        setAt: 100,
        lastReason: 'continuing',
      });
      expect(projected.goalTerminal).toBeNull();
    },
  );

  it('projects completion as achieved and stops active_goal', () => {
    const projected = projectGoalStateToLegacy(payload('complete', 'complete'));

    expect(projected.goalStatus.kind).toBe('achieved');
    expect(projected.activeGoal).toBeNull();
    expect(projected.goalTerminal).toMatchObject({
      kind: 'achieved',
      condition: 'ship it',
      iterations: 4,
      durationMs: 2000,
    });
  });

  it('projects clear as cleared using the prior goal objective', () => {
    const projected = projectGoalStateToLegacy(
      payload('clear', 'active', null),
      GOAL,
    );

    expect(projected.goalStatus).toMatchObject({
      kind: 'cleared',
      condition: 'ship it',
    });
    expect(projected.activeGoal).toBeNull();
    expect(projected.goalTerminal).toBeNull();
  });

  it('projects pause as a non-terminal legacy paused state', () => {
    const projected = projectGoalStateToLegacy(payload('pause', 'paused'));

    expect(projected.goalStatus.kind).toBe('paused');
    expect(projected.activeGoal).toBeNull();
    expect(projected.goalTerminal).toBeNull();
  });

  it.each(['blocked', 'usage_limited'] as const)(
    'projects %s as a legacy stopped state',
    (status) => {
      const projected = projectGoalStateToLegacy(payload(status, status));

      expect(projected.goalStatus.kind).toBe('aborted');
      expect(projected.activeGoal).toBeNull();
      expect(projected.goalTerminal).toMatchObject({
        kind: 'aborted',
        condition: 'ship it',
      });
    },
  );

  it('uses checking for active runtime progress without widening the union', () => {
    const projected = projectGoalStateToLegacy(
      payload('turn_finished', 'active'),
    );

    expect(projected.goalStatus.kind).toBe('checking');
    expect(projected.activeGoal).not.toBeNull();
    expect(projected.goalTerminal).toBeNull();
  });

  it('does not repeat an aborted terminal after a paused turn finishes', () => {
    const projected = projectGoalStateToLegacy(
      payload('turn_finished', 'paused'),
    );

    expect(projected.goalStatus.kind).toBe('checking');
    expect(projected.activeGoal).toBeNull();
    expect(projected.goalTerminal).toBeNull();
  });
});
