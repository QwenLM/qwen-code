/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModBudget } from './dispatch.js';

describe('ModBudget', () => {
  let now = 0;

  beforeEach(() => {
    now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
  });

  afterEach(() => vi.restoreAllMocks());

  it('charges 12 seconds across 5 seconds of work, 90 seconds lent, and 7 seconds of work', () => {
    const budget = new ModBudget(60_000);
    now += 5_000;
    budget.pause();
    now += 90_000;
    expect(budget.remainingMs).toBe(55_000);
    budget.resume();
    now += 7_000;
    expect(budget.remainingMs).toBe(48_000);
    expect(budget.expired).toBe(false);
  });

  it('accumulates work across repeated loans without refreshing the allowance', () => {
    const budget = new ModBudget(60_000);
    for (let i = 0; i < 3; i++) {
      now += 10_000;
      budget.pause();
      now += 90_000;
      budget.resume();
    }
    expect(budget.remainingMs).toBe(30_000);
    now += 30_000;
    expect(budget.expired).toBe(true);
    budget.pause();
    now += 90_000;
    budget.resume();
    expect(budget.remainingMs).toBe(0);
    expect(budget.expired).toBe(true);
  });

  it('keeps an outer loan paused after a nested loan returns', async () => {
    const budget = new ModBudget(60_000);
    now += 5_000;
    await budget.lend(async () => {
      now += 90_000;
      await budget.lend(async () => {
        now += 90_000;
      });
      expect(budget.lending).toBe(true);
      expect(budget.remainingMs).toBe(55_000);
      now += 90_000;
    });
    expect(budget.lending).toBe(false);
    now += 7_000;
    expect(budget.remainingMs).toBe(48_000);
  });

  it('returns every nested loan when the borrowed operation rejects', async () => {
    const budget = new ModBudget(10_000);
    now += 2_000;
    await expect(
      budget.lend(() =>
        budget.lend(async () => {
          now += 90_000;
          throw new Error('native failed');
        }),
      ),
    ).rejects.toThrow('native failed');
    expect(budget.lending).toBe(false);
    now += 8_000;
    expect(budget.remainingMs).toBe(0);
    expect(budget.expired).toBe(true);
  });
});
