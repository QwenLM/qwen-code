/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  capGoalCheckpointFailure,
  GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS,
  GOAL_CHECKPOINT_STALLED_REASON,
  GOAL_CHECKPOINT_UNREACHABLE_REASON,
  GOAL_CHECKPOINT_UNUSABLE_REASON,
  goalCheckpointHealthLine,
  goalCheckpointHealthVisible,
  goalCheckpointStalledReason,
  goalLimitKindForReason,
  GOAL_PAUSE_REASON_COMMAND,
  GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
  GOAL_PAUSE_REASON_MAX_CHARACTERS,
  GOAL_PAUSE_REASON_NO_PROGRESS,
  GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT,
  GOAL_PAUSE_REASON_SESSION_DISPOSED,
  GOAL_PAUSE_REASON_STOP_HOOK_CAP,
  GOAL_PAUSE_REASON_USER_INTERRUPT,
  goalActiveTimeBudgetReason,
  goalPauseReasonForFailure,
  goalPauseReasonForHeadlessFailure,
  goalPauseReasonForRunBudget,
  goalTurnBudgetReason,
  validateGoalPauseReason,
} from './goal-protocol.js';

const codePoints = (value: string) => [...value].length;

describe('goal pause reasons', () => {
  // The builders truncate to the bound and the validator rejects above it.
  // Nothing else in the tree exercises both sides, so an off-by-one on either
  // would let an in-tree host write a reason the daemon and ACP control routes
  // reject -- the two paths would disagree on what a legal reason is.
  it('accepts every shared constant', () => {
    for (const reason of [
      GOAL_PAUSE_REASON_USER_INTERRUPT,
      GOAL_PAUSE_REASON_COMMAND,
      GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
      GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT,
      GOAL_PAUSE_REASON_STOP_HOOK_CAP,
      GOAL_PAUSE_REASON_SESSION_DISPOSED,
      GOAL_PAUSE_REASON_NO_PROGRESS,
    ]) {
      expect(validateGoalPauseReason(reason)).toBeNull();
    }
  });

  it('accepts exactly the bound and rejects one code point past it', () => {
    expect(
      validateGoalPauseReason('x'.repeat(GOAL_PAUSE_REASON_MAX_CHARACTERS)),
    ).toBeNull();
    expect(
      validateGoalPauseReason('x'.repeat(GOAL_PAUSE_REASON_MAX_CHARACTERS + 1)),
    ).toBe(
      `Goal pause reason exceeds ${GOAL_PAUSE_REASON_MAX_CHARACTERS} characters`,
    );
  });

  it('measures the bound in code points, not UTF-16 units', () => {
    // 500 astral code points are 1000 UTF-16 units. A length-only check would
    // refuse a reason the truncator just produced.
    const emoji = '\u{1F600}'.repeat(GOAL_PAUSE_REASON_MAX_CHARACTERS);
    expect(emoji.length).toBe(GOAL_PAUSE_REASON_MAX_CHARACTERS * 2);
    expect(codePoints(emoji)).toBe(GOAL_PAUSE_REASON_MAX_CHARACTERS);
    expect(validateGoalPauseReason(emoji)).toBeNull();
  });

  it('rejects an empty or blank reason', () => {
    expect(validateGoalPauseReason('')).toBe(
      'Goal pause reason must not be empty',
    );
    expect(validateGoalPauseReason('   ')).toBe(
      'Goal pause reason must not be empty',
    );
  });

  it('builds reasons the validator accepts, however long the detail', () => {
    for (const built of [
      goalPauseReasonForFailure('x'.repeat(5_000)),
      goalPauseReasonForHeadlessFailure('x'.repeat(5_000)),
      goalPauseReasonForRunBudget('x'.repeat(5_000)),
    ]) {
      expect(codePoints(built)).toBe(GOAL_PAUSE_REASON_MAX_CHARACTERS);
      expect(validateGoalPauseReason(built)).toBeNull();
    }
  });

  it('falls back to a detail-free sentence when given none', () => {
    expect(goalPauseReasonForFailure('   ')).toBe(
      'The Goal turn could not finish. Run /goal resume to continue.',
    );
    expect(goalPauseReasonForRunBudget('   ')).toBe(
      'The headless run stopped at a budget. Resume the Goal in a later run.',
    );
    expect(goalPauseReasonForHeadlessFailure('   ')).toBe(
      'The headless run stopped before the Goal turn finished. Resume the Goal in a later run.',
    );
  });

  it('keeps the headless register free of slash commands', () => {
    // A headless process has already exited by the time a user reads these,
    // so none of them may point at a slash command.
    for (const reason of [
      GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
      GOAL_PAUSE_REASON_NO_PROGRESS,
      goalPauseReasonForRunBudget('wall-time'),
      goalPauseReasonForHeadlessFailure('the model stream broke'),
    ]) {
      expect(reason).not.toContain('/goal resume');
      expect(reason).not.toContain('/goal ');
    }
    expect(
      goalPauseReasonForHeadlessFailure('the model stream broke'),
    ).toContain('the model stream broke');
  });

  it('names the budget that tripped', () => {
    expect(goalPauseReasonForRunBudget('wall-time')).toContain('wall-time');
    expect(goalPauseReasonForRunBudget('tool-calls')).toContain('tool-calls');
  });
});

describe('goal checkpoint stall reasons', () => {
  it('advises by what the check that spent the last stall ran into', () => {
    expect(goalCheckpointStalledReason('capacity')).toBe(
      GOAL_CHECKPOINT_STALLED_REASON,
    );
    expect(goalCheckpointStalledReason('unusable')).toBe(
      GOAL_CHECKPOINT_UNUSABLE_REASON,
    );
    expect(goalCheckpointStalledReason('unreachable')).toBe(
      GOAL_CHECKPOINT_UNREACHABLE_REASON,
    );
    // Capacity is fixed by a narrower objective; malformed output is not,
    // and telling that user to rewrite their Goal is the bug.
    expect(GOAL_CHECKPOINT_STALLED_REASON).toContain('narrower objective');
    expect(GOAL_CHECKPOINT_UNUSABLE_REASON).toContain(
      'Narrowing the objective does not fix this',
    );
    // A check that never answered may have run past its own ceiling on a
    // window too large to verify in time, so its advice keeps every remedy
    // that can apply instead of blaming the provider.
    expect(GOAL_CHECKPOINT_UNREACHABLE_REASON).toContain(
      'model.goalCheckpointTimeoutSeconds',
    );
    expect(GOAL_CHECKPOINT_UNREACHABLE_REASON).toContain(
      'narrow the objective',
    );
    expect(GOAL_CHECKPOINT_UNREACHABLE_REASON).not.toContain(
      'does not fix this',
    );
  });

  it('keeps resumability on limitKind rather than on the stop prose', () => {
    // The stall stop writes `limitKind: 'evidence_catalog'` beside every one
    // of these reasons; none may start denoting a kind of its own, or the
    // prose and the field could disagree about how a resume behaves.
    for (const reason of [
      GOAL_CHECKPOINT_STALLED_REASON,
      GOAL_CHECKPOINT_UNUSABLE_REASON,
      GOAL_CHECKPOINT_UNREACHABLE_REASON,
    ]) {
      expect(goalLimitKindForReason(reason)).toBeUndefined();
    }
  });

  it('caps a failure diagnostic on a code point boundary', () => {
    expect(capGoalCheckpointFailure('  Error: provider failed  ')).toBe(
      'Error: provider failed',
    );
    const exact = 'x'.repeat(GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS);
    expect(capGoalCheckpointFailure(exact)).toBe(exact);

    // Astral characters are two UTF-16 units: a slice by `.length` would
    // split one and leave a lone surrogate in the journaled record.
    const capped = capGoalCheckpointFailure(
      '😀'.repeat(GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS + 10),
    );
    expect(codePoints(capped)).toBe(GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS);
    expect(capped.endsWith('…')).toBe(true);
    expect([...capped].slice(0, -1).every((char) => char === '😀')).toBe(true);
  });

  it('keeps a failure diagnostic on one display-safe line', () => {
    expect(capGoalCheckpointFailure('Error: a\nb c')).toBe('Error: a b c');
    expect(capGoalCheckpointFailure('Error: a\r\n    b\tc')).toBe(
      'Error: a b c',
    );
    // Escape sequences go whole and bidi overrides go entirely, so no
    // surface can be repainted or reordered by a provider's error text.
    expect(
      capGoalCheckpointFailure(
        'Error: \u001b[31mred\u001b[0m rate\u202e limit\u0007',
      ),
    ).toBe('Error: red rate limit');

    // Collapsing runs before the cap, so a response body's indentation
    // cannot spend the bound.
    const capped = capGoalCheckpointFailure(
      `Error:${'\n    word'.repeat(200)}`,
    );
    expect(capped).not.toMatch(/\s{2,}|\n/);
    expect(codePoints(capped)).toBe(GOAL_CHECKPOINT_FAILURE_MAX_CHARACTERS);
  });
});

describe('goal checkpoint health visibility', () => {
  const failure = 'Error: provider failed';

  it.each([
    [
      'an active Goal whose failure spent no stall',
      { status: 'active', lastCheckpointFailure: failure },
      true,
    ],
    [
      'an active Goal mid-streak',
      { status: 'active', checkpointStalls: 2, lastCheckpointFailure: failure },
      true,
    ],
    [
      'a Goal the stall breaker stopped',
      {
        status: 'usage_limited',
        checkpointStalls: 3,
        lastCheckpointFailure: failure,
      },
      true,
    ],
    [
      'a paused Goal that keeps its streak',
      { status: 'paused', checkpointStalls: 1, lastCheckpointFailure: failure },
      true,
    ],
    [
      'a Goal paused for another reason after a stall-free failure',
      { status: 'paused', lastCheckpointFailure: failure },
      false,
    ],
    [
      'a Goal stopped by another bound after a stall-free failure',
      { status: 'usage_limited', lastCheckpointFailure: failure },
      false,
    ],
    [
      'a Goal stopped because its checkpoint request was too large',
      {
        status: 'usage_limited',
        limitKind: 'checkpoint_request',
        lastCheckpointFailure: failure,
      },
      true,
    ],
    [
      'a Goal stopped by its checkpoint request with a blank diagnostic',
      {
        status: 'usage_limited',
        limitKind: 'checkpoint_request',
        lastCheckpointFailure: ' ',
      },
      false,
    ],
    [
      'a completed Goal that still carries both fields',
      {
        status: 'complete',
        checkpointStalls: 1,
        lastCheckpointFailure: failure,
      },
      false,
    ],
    ['a healthy active Goal', { status: 'active' }, false],
  ] as const)('%s', (_label, goal, expected) => {
    expect(goalCheckpointHealthVisible(goal)).toBe(expected);
  });
});

describe('goal checkpoint health line', () => {
  const failure = 'Error: provider failed';

  it('words the streak, or the stall-free failure, then the diagnostic', () => {
    expect(
      goalCheckpointHealthLine({
        status: 'active',
        checkpointStalls: 2,
        lastCheckpointFailure: failure,
      }),
    ).toBe('2/3 stalled · Error: provider failed');
    expect(
      goalCheckpointHealthLine({
        status: 'active',
        lastCheckpointFailure: ` ${failure} `,
      }),
    ).toBe('last check failed · Error: provider failed');
    // A bare streak carries no trailing separator.
    expect(
      goalCheckpointHealthLine({ status: 'paused', checkpointStalls: 2 }),
    ).toBe('2/3 stalled');
  });

  it('shows nothing the visibility rule hides', () => {
    expect(
      goalCheckpointHealthLine({
        status: 'complete',
        checkpointStalls: 1,
        lastCheckpointFailure: failure,
      }),
    ).toBeUndefined();
    expect(
      goalCheckpointHealthLine({
        status: 'paused',
        lastCheckpointFailure: failure,
      }),
    ).toBeUndefined();
  });

  it('cleans the diagnostic before trimming and joining it', () => {
    // A diagnostic the cleaner empties leaves no dangling separator.
    expect(
      goalCheckpointHealthLine(
        { status: 'active', checkpointStalls: 1, lastCheckpointFailure: 'x' },
        () => ' ',
      ),
    ).toBe('1/3 stalled');
  });
});

describe('Goal cadence budget reasons', () => {
  it('formats singular and plural turn budgets', () => {
    expect(goalTurnBudgetReason(1)).toContain('(1 turn)');
    expect(goalTurnBudgetReason(2)).toContain('(2 turns)');
  });

  it('reports sub-minute time budgets in seconds', () => {
    expect(goalActiveTimeBudgetReason(500)).toContain('(1 second)');
    expect(goalActiveTimeBudgetReason(30_000)).toContain('(30 seconds)');
    expect(goalActiveTimeBudgetReason(60_000)).toContain('(1 minute)');
    expect(goalActiveTimeBudgetReason(120_000)).toContain('(2 minutes)');
  });
});
