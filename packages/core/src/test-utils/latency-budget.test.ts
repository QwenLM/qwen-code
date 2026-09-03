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
});
