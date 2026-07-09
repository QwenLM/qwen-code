/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  GOAL_CLEAR_KEYWORDS,
  goalArgOf,
  isGoalClearCommand,
  isGoalClearKeyword,
} from './goalCondition';

describe('goalArgOf', () => {
  it('returns an empty string for a bare /goal', () => {
    expect(goalArgOf('/goal')).toBe('');
    expect(goalArgOf('/goal   ')).toBe('');
  });

  it('returns the condition, trimmed', () => {
    expect(goalArgOf('/goal  ship it  ')).toBe('ship it');
  });

  it('is case-insensitive on the command itself', () => {
    expect(goalArgOf('/GOAL ship it')).toBe('ship it');
  });

  it('keeps a multi-line condition intact', () => {
    expect(goalArgOf('/goal line one\nline two')).toBe('line one\nline two');
  });

  it('does not strip a command that merely starts with goal', () => {
    expect(goalArgOf('/goalkeeper x')).toBe('/goalkeeper x');
  });
});

describe('isGoalClearKeyword', () => {
  it.each([...GOAL_CLEAR_KEYWORDS])('treats %s as a clear keyword', (word) => {
    expect(isGoalClearKeyword(word)).toBe(true);
  });

  it('ignores surrounding whitespace and case', () => {
    expect(isGoalClearKeyword('  Clear ')).toBe(true);
    expect(isGoalClearKeyword('CANCEL')).toBe(true);
  });

  it('does not match a real condition that merely contains a keyword', () => {
    expect(isGoalClearKeyword('clear the build cache')).toBe(false);
    expect(isGoalClearKeyword('stop the flaky test from failing')).toBe(false);
  });

  it('does not match an empty condition', () => {
    expect(isGoalClearKeyword('')).toBe(false);
  });
});

describe('isGoalClearCommand', () => {
  it('matches /goal <clear-keyword> in any case', () => {
    expect(isGoalClearCommand('/goal clear')).toBe(true);
    expect(isGoalClearCommand('/goal  STOP ')).toBe(true);
  });

  it('does not match a bare /goal', () => {
    expect(isGoalClearCommand('/goal')).toBe(false);
  });

  it('does not match /goal <condition>', () => {
    expect(isGoalClearCommand('/goal clear the build cache')).toBe(false);
  });
});
