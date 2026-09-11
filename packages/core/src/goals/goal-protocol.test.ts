/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
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
