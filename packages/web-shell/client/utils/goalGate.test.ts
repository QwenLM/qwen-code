/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { GoalRecord } from '@qwen-code/sdk/daemon';
import {
  GOAL_EVIDENCE_LIMIT_REASONS,
  canResumeGoal,
  isGoalEvidenceLimited,
  isGoalGateBlocked,
} from './goalGate';

const [CATALOG_EXHAUSTED, CHECKPOINT_TOO_LARGE] = GOAL_EVIDENCE_LIMIT_REASONS;

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

describe('isGoalEvidenceLimited', () => {
  it('reads `limitKind` as the field of record', () => {
    expect(isGoalEvidenceLimited(goal({ limitKind: 'evidence_catalog' }))).toBe(
      true,
    );
    expect(
      isGoalEvidenceLimited(goal({ limitKind: 'checkpoint_request' })),
    ).toBe(true);
    expect(isGoalEvidenceLimited(goal())).toBe(false);
  });

  it('falls back to the sentinel prose for Goals persisted before `limitKind`', () => {
    // The whole point of the fallback: these records carry no `limitKind` at
    // all, so a gate that keys off that field alone reads them as resumable.
    expect(isGoalEvidenceLimited(goal({ lastReason: CATALOG_EXHAUSTED }))).toBe(
      true,
    );
    expect(
      isGoalEvidenceLimited(goal({ lastReason: CHECKPOINT_TOO_LARGE })),
    ).toBe(true);
  });

  it('leaves every other stop reason alone', () => {
    // Operational stops carry prose too, and they ARE resumable -- a fallback
    // that matched loosely would strand them with no Resume control.
    expect(
      isGoalEvidenceLimited(
        goal({ lastReason: 'The provider rate-limited us' }),
      ),
    ).toBe(false);
    expect(
      isGoalEvidenceLimited(
        goal({ lastReason: CATALOG_EXHAUSTED.slice(0, -1) }),
      ),
    ).toBe(false);
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

  it('offers resume for an evidence-limited Goal, by field or by sentinel', () => {
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
      canResumeGoal(
        goal({ status: 'usage_limited', lastReason: CHECKPOINT_TOO_LARGE }),
      ),
    ).toBe(true);
  });

  it('ignores evidence metadata on other stopped statuses', () => {
    expect(
      canResumeGoal(goal({ status: 'paused', lastReason: CATALOG_EXHAUSTED })),
    ).toBe(true);
    expect(
      canResumeGoal(goal({ status: 'blocked', limitKind: 'evidence_catalog' })),
    ).toBe(true);
  });
});

describe('core is the authority on the evidence-limit sentinels', () => {
  // The Web Shell client bundles for the browser and does not depend on
  // `@qwen-code/qwen-code-core`, so these strings cannot simply be imported
  // from the package that writes them. They are duplicated, and a comment
  // asking the next person to "keep in sync" is not a mechanism. Drift here is
  // silent and user-visible: the UI would offer a Resume button on a Goal the
  // reducer is guaranteed to reject with an invalid-transition 409.
  const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));
  const source = readFileSync(
    join(repoRoot, 'packages/core/src/goals/goal-protocol.ts'),
    'utf8',
  );

  const literal = (name: string): string => {
    const match = new RegExp(
      `export const ${name} =\\s*\\n?\\s*'([^']*)';`,
    ).exec(source);
    expect(
      match,
      `${name} literal not found in goal-protocol.ts`,
    ).not.toBeNull();
    return match![1];
  };

  it('agrees with goal-protocol.ts on both sentinel reasons', () => {
    expect(GOAL_EVIDENCE_LIMIT_REASONS).toEqual([
      literal('GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON'),
      literal('GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON'),
    ]);
  });

  it('agrees with goal-reducer.ts that both are still the only fallback', () => {
    // If core ever grows a third sentinel, `goalLimitKindForReason` gains a
    // third branch -- and this copy would silently keep offering Resume on it.
    const reducer = readFileSync(
      join(repoRoot, 'packages/core/src/goals/goal-protocol.ts'),
      'utf8',
    );
    const branches = reducer.match(/if \(reason === GOAL_[A-Z_]+\) \{/g) ?? [];
    expect(branches).toHaveLength(GOAL_EVIDENCE_LIMIT_REASONS.length);
  });
});
