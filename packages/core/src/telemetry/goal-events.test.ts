/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  GoalRecord,
  GoalSnapshotV2,
  GoalStateCause,
} from '../goals/goal-protocol.js';
import {
  goalStateEventFromSnapshot,
  isGoalStateEventCause,
} from './goal-events.js';
import { GOAL_STATE_EVENT_CAUSES } from './types.js';

const NOW = 1_000_000;
const REPORTED_CAUSES = [
  'create',
  'replace',
  'edit',
  'pause',
  'resume',
  'complete',
  'blocked',
  'usage_limited',
  'verifier_reject',
] as const;
const UNREPORTED_CAUSES = [
  'turn_finished',
  'checkpoint',
  'migrated',
  'verifier_accept',
] as const;

function goal(overrides: Partial<GoalRecord> = {}): GoalRecord {
  return {
    goalId: 'g-1',
    revision: 3,
    objective: 'ship the release notes',
    status: 'paused',
    evidenceCursor: { recordId: 'r-1' },
    turnCount: 4,
    activeTimeMs: 12_000,
    tokensUsed: 81_234,
    createdAt: NOW - 60_000,
    updatedAt: NOW - 5_000,
    ...overrides,
  };
}

function snapshot(
  value: GoalRecord | null,
  extra: Partial<GoalSnapshotV2> = {},
): GoalSnapshotV2 {
  return { v: 2, activity: 'idle', goal: value, ...extra };
}

describe('goalStateEventFromSnapshot', () => {
  it('classifies every runtime cause and pins the reported set', () => {
    expectTypeOf<GoalStateCause>().toEqualTypeOf<
      | (typeof REPORTED_CAUSES)[number]
      | (typeof UNREPORTED_CAUSES)[number]
      | 'clear'
    >();
    expect([...GOAL_STATE_EVENT_CAUSES].sort()).toEqual(
      [...REPORTED_CAUSES, 'clear'].sort(),
    );
  });

  it.each(REPORTED_CAUSES)('reports %s', (cause) => {
    expect(
      goalStateEventFromSnapshot(snapshot(goal()), cause, NOW),
    ).toMatchObject({
      'event.name': 'goal_state',
      cause,
      goal_id: 'g-1',
      revision: 3,
    });
  });

  it.each([...UNREPORTED_CAUSES, undefined])('does not report %s', (cause) => {
    // Per-turn causes would multiply the volume; an accept is always followed
    // by the stop it accepted; a missing cause is an activity change.
    expect(isGoalStateEventCause(cause)).toBe(false);
    expect(
      goalStateEventFromSnapshot(snapshot(goal()), cause, NOW),
    ).toBeUndefined();
  });

  it('carries the figures and none of the free text', () => {
    const event = goalStateEventFromSnapshot(
      snapshot(
        goal({
          status: 'usage_limited',
          limitKind: 'token_budget',
          tokenBudget: 80_000,
          lastReason:
            'The Goal spent its autonomous token budget (80,000 tokens).',
        }),
      ),
      'usage_limited',
      NOW,
    );

    expect(event).toEqual({
      'event.name': 'goal_state',
      'event.timestamp': expect.any(String),
      cause: 'usage_limited',
      goal_id: 'g-1',
      revision: 3,
      status: 'usage_limited',
      limit_kind: 'token_budget',
      turn_count: 4,
      tokens_used: 81_234,
      token_budget: 80_000,
      active_time_ms: 12_000,
      objective_length: 22,
    });
    // The objective and the stop reason are text a user or a model wrote.
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain('release notes');
    expect(serialized).not.toContain('autonomous token budget');
  });

  it('leaves figures the Goal does not have absent rather than undefined', () => {
    const event = goalStateEventFromSnapshot(snapshot(goal()), 'pause', NOW)!;

    for (const key of [
      'limit_kind',
      'token_budget',
      'turn_budget',
      'active_time_budget_ms',
    ]) {
      expect(Object.keys(event)).not.toContain(key);
    }
  });

  it('carries the raw no-progress streak without adding a stop classification', () => {
    expect(
      goalStateEventFromSnapshot(
        snapshot(goal({ noProgressTurns: 3 })),
        'pause',
        NOW,
      ),
    ).toMatchObject({ cause: 'pause', no_progress_turns: 3 });
    expect(
      goalStateEventFromSnapshot(snapshot(goal()), 'pause', NOW),
    ).not.toHaveProperty('no_progress_turns');
    expect(
      goalStateEventFromSnapshot(
        snapshot(
          goal({
            status: 'usage_limited',
            limitKind: 'token_budget',
            noProgressTurns: 3,
          }),
        ),
        'usage_limited',
        NOW,
      ),
    ).toMatchObject({
      cause: 'usage_limited',
      limit_kind: 'token_budget',
      no_progress_turns: 3,
    });
  });

  it('preserves zero figures on a newly created Goal', () => {
    const event = goalStateEventFromSnapshot(
      snapshot(
        goal({
          status: 'active',
          turnCount: 0,
          tokensUsed: 0,
          activeTimeMs: 0,
          createdAt: NOW,
          updatedAt: NOW,
        }),
      ),
      'create',
      NOW,
    );

    expect(event).toMatchObject({
      turn_count: 0,
      tokens_used: 0,
      active_time_ms: 0,
    });
    expect(Object.keys(event!)).toEqual(
      expect.arrayContaining(['turn_count', 'tokens_used', 'active_time_ms']),
    );
  });

  it("reads an active Goal's running clock as of the broadcast", () => {
    // `activeTimeMs` is only committed on a transition; an active Goal has
    // been accruing since `updatedAt`.
    const event = goalStateEventFromSnapshot(
      snapshot(goal({ status: 'active' })),
      'resume',
      NOW,
    );

    expect(event?.active_time_ms).toBe(17_000);
  });

  it('counts the objective in code points', () => {
    const event = goalStateEventFromSnapshot(
      snapshot(goal({ objective: '发布说明🚀' })),
      'create',
      NOW,
    );

    expect(event?.objective_length).toBe(5);
  });

  it('names the cleared Goal and carries no figures on clear', () => {
    const event = goalStateEventFromSnapshot(
      snapshot(null, {
        clearedGoal: { goalId: 'g-1', revision: 3, updatedAt: NOW },
      }),
      'clear',
      NOW,
    );

    expect(event).toEqual({
      'event.name': 'goal_state',
      'event.timestamp': expect.any(String),
      cause: 'clear',
      goal_id: 'g-1',
      revision: 3,
    });
  });

  it('reports nothing for a clear with no Goal to name', () => {
    expect(
      goalStateEventFromSnapshot(snapshot(null), 'clear', NOW),
    ).toBeUndefined();
  });
});
