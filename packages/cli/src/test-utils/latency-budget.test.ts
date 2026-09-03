/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';

import { expectWithinLatencyBudget } from './latency-budget.js';

describe('expectWithinLatencyBudget', () => {
  afterEach(() => {
    delete process.env['QWEN_SKIP_LATENCY_BUDGETS'];
  });

  it('enforces the budget where the number means something', () => {
    delete process.env['QWEN_SKIP_LATENCY_BUDGETS'];
    expect(() => expectWithinLatencyBudget(10, 100)).not.toThrow();
    expect(() => expectWithinLatencyBudget(1762, 1000)).toThrow();
  });

  it('skips the budget on the shared pool', () => {
    // The pool runs identical work 5x apart depending on which host it lands
    // on (#10490), so a bound measured there is a coin flip, not a signal.
    process.env['QWEN_SKIP_LATENCY_BUDGETS'] = '1';
    expect(() => expectWithinLatencyBudget(1762, 1000)).not.toThrow();
  });

  it('treats an empty value as not set', () => {
    // The workflow renders '' on the hosted lanes rather than omitting the key.
    process.env['QWEN_SKIP_LATENCY_BUDGETS'] = '';
    expect(() => expectWithinLatencyBudget(1762, 1000)).toThrow();
  });

  it('treats values that read as off as enforcing', () => {
    // '0' and 'false' are truthy strings; a raw truthiness gate would skip
    // every budget for them — the opposite of the boolean reflex.
    for (const value of ['0', 'false']) {
      process.env['QWEN_SKIP_LATENCY_BUDGETS'] = value;
      expect(() => expectWithinLatencyBudget(1762, 1000)).toThrow();
    }
  });

  it('keeps asserting on the pool when the duration is the property', () => {
    // Three of the quarantined cases have no other expect() — a complexity
    // bound or a no-hang close guarantee is the whole test. Skipping there
    // would leave them running and checking nothing, so they keep a relaxed
    // bound:
    // wide enough for a 5x-contended host, far too tight for a quadratic
    // regression.
    process.env['QWEN_SKIP_LATENCY_BUDGETS'] = '1';
    expect(() =>
      expectWithinLatencyBudget(1500, 100, { poolMultiplier: 20 }),
    ).not.toThrow();
    expect(() =>
      expectWithinLatencyBudget(2500, 100, { poolMultiplier: 20 }),
    ).toThrow();
  });
});
