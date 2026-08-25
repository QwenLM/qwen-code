/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { GoalRecord } from '@qwen-code/sdk/daemon';
import { canResumeGoal, isGoalGateBlocked } from './goalGate';

// A real sentinel reason from core's goal-protocol.ts, used here as inert
// prose: the gate must not parse `lastReason`, so the strongest fixture is the
// string that a prose-sniffing gate would be most tempted to react to.
const CATALOG_EXHAUSTED =
  'The current Goal revision exceeded the bounded evidence catalog. Automatic retries cannot recover. Edit or replace the Goal before resuming it.';

const goal = (over: Partial<GoalRecord> = {}): GoalRecord => ({
  goalId: 'g1',
  revision: 1,
  objective: 'ship it',
  status: 'usage_limited',
  evidenceCursor: { recordId: null },
  turnCount: 0,
  activeTimeMs: 0,
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('isGoalGateBlocked', () => {
  it('fails closed on an unhydrated goal state and opens once it is known', () => {
    expect(isGoalGateBlocked({ sessionId: 's1' })).toBe(true);
    expect(
      isGoalGateBlocked({
        sessionId: 's1',
        goalState: { v: 2, goal: null, activity: 'idle' },
      }),
    ).toBe(false);
    expect(
      isGoalGateBlocked({
        sessionId: 's1',
        goalState: { v: 2, goal: goal({ status: 'active' }), activity: 'idle' },
      }),
    ).toBe(true);
    expect(isGoalGateBlocked({ goalState: undefined })).toBe(false);
  });
});

describe('canResumeGoal', () => {
  it('mirrors the reducer on the statuses that refuse resume outright', () => {
    expect(canResumeGoal(goal({ status: 'complete' }))).toBe(false);
    expect(canResumeGoal(goal({ status: 'active' }))).toBe(false);
  });

  it('offers resume for every stopped Goal the reducer accepts', () => {
    expect(canResumeGoal(goal({ status: 'paused' }))).toBe(true);
    expect(canResumeGoal(goal({ status: 'blocked' }))).toBe(true);
    expect(canResumeGoal(goal({ status: 'usage_limited' }))).toBe(true);
  });

  it('decides by status alone, never by stop metadata', () => {
    // The reducer resumes an evidence-limited Goal by restarting its evidence
    // window, so `limitKind` and `lastReason` must not withhold the button --
    // on any stopped status, marked any way.
    expect(
      canResumeGoal(
        goal({ status: 'usage_limited', limitKind: 'evidence_catalog' }),
      ),
    ).toBe(true);
    expect(
      canResumeGoal(
        goal({ status: 'usage_limited', lastReason: CATALOG_EXHAUSTED }),
      ),
    ).toBe(true);
    expect(
      canResumeGoal(goal({ status: 'paused', lastReason: CATALOG_EXHAUSTED })),
    ).toBe(true);
    expect(
      canResumeGoal(goal({ status: 'blocked', limitKind: 'evidence_catalog' })),
    ).toBe(true);
  });
});
