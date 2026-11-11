/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { createDynamicTurnBudget } from './turn-budget.js';

describe('dynamic turn budget', () => {
  it('grants only the difference between cumulative stages', () => {
    const budget = createDynamicTurnBudget([14, 24, 47])!;
    expect(budget.finalLimit).toBe(47);
    expect(budget.getSnapshot(0)).toEqual({ remainingTurns: 14 });
    expect(budget.getSnapshot(13)).toEqual({ remainingTurns: 1 });
    expect(budget.getSnapshot(14)).toEqual({
      remainingTurns: 10,
      additionalTurns: 10,
    });
    expect(budget.getSnapshot(15)).toEqual({ remainingTurns: 9 });
    expect(budget.getSnapshot(24)).toEqual({
      remainingTurns: 23,
      additionalTurns: 23,
    });
    expect(budget.getSnapshot(46)).toEqual({ remainingTurns: 1 });
    expect(budget.getSnapshot(47)).toEqual({ remainingTurns: 0, exhausted: true });
    expect(budget.getSnapshot(50)).toEqual({ remainingTurns: 0, exhausted: true });
  });

  it.each([
    { cap: 10, at: 0, snapshot: { remainingTurns: 10 } },
    { cap: 14, at: 13, snapshot: { remainingTurns: 1 } },
    { cap: 20, at: 14, snapshot: { remainingTurns: 6, additionalTurns: 6 } },
    { cap: 100, at: 24, snapshot: { remainingTurns: 23, additionalTurns: 23 } },
  ])('respects a caller hard limit of $cap', ({ cap, at, snapshot }) => {
    const budget = createDynamicTurnBudget([14, 24, 47], cap)!;
    expect(budget.finalLimit).toBe(Math.min(cap, 47));
    expect(budget.getSnapshot(at)).toEqual(snapshot);
    expect(budget.getSnapshot(budget.finalLimit)).toEqual({ remainingTurns: 0, exhausted: true });
  });

  it('preserves a zero caller limit and starts each query with a fresh budget', () => {
    expect(createDynamicTurnBudget([14, 24, 47], 0)).toBeUndefined();
    createDynamicTurnBudget([14, 24, 47])!.getSnapshot(24);
    expect(createDynamicTurnBudget([14, 24, 47])!.getSnapshot(0)).toEqual({
      remainingTurns: 14,
    });
  });
});
