/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  detectAvailableMemoryMb,
  formatMemoryBudgetStderr,
  isValidMemoryBudgetMb,
  legacyChildCeilingMb,
  MAX_CHILD_HEAP_MB,
  MAX_MEMORY_BUDGET_MB,
  MIN_CHILD_HEAP_MB,
  MIN_MEMORY_BUDGET_MB,
  normalizeMemoryBudgetMb,
  recommendedChildShareMb,
  resolveDaemonMemoryBudget,
} from './daemon-memory-budget.js';

const MB = 1024 * 1024;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('resolveDaemonMemoryBudget', () => {
  it.each([
    // available MB, configured, effective, reserve, pool, legacy ceiling
    [32_768, 16_384, 16_384, 1_024, 15_360, 16_384],
    [16_384, 8_192, 8_192, 819, 7_373, 8_192],
    [8_192, 4_096, 4_096, 409, 3_687, 4_096],
    [3_494, 1_747, 1_747, 256, 1_491, 1_747],
    [2_048, 1_024, 1_024, 256, 768, 1_024],
  ])(
    'derives the figures from %i MB of available memory',
    (
      availableMemoryMb,
      configuredBudgetMb,
      effectiveBudgetMb,
      rootReserveMb,
      childPoolMb,
      legacyChildCeilingMb,
    ) => {
      expect(resolveDaemonMemoryBudget({ availableMemoryMb })).toEqual({
        configuredBudgetMb,
        effectiveBudgetMb,
        budgetSource: 'derived',
        availableMemoryMb,
        availableMemorySource: 'host',
        rootReserveMb,
        childPoolMb,
        legacyChildCeilingMb,
        insufficientMemory: effectiveBudgetMb < MIN_MEMORY_BUDGET_MB,
      });
    },
  );

  it('never reports a budget the host cannot back', () => {
    // The point of separating configured from effective: a tiny host must not
    // report a denominator larger than itself, and the minimum-budget constant
    // must not be allowed to invent one.
    for (const availableMemoryMb of [256, 512, 768, 1_024, 2_048, 32_768]) {
      const budget = resolveDaemonMemoryBudget({ availableMemoryMb });
      expect(budget.effectiveBudgetMb).toBeLessThanOrEqual(availableMemoryMb);
    }
  });

  it('never reports a reserve larger than the budget it comes out of', () => {
    for (const availableMemoryMb of [128, 256, 512, 768]) {
      const budget = resolveDaemonMemoryBudget({ availableMemoryMb });
      expect(budget.rootReserveMb).toBeLessThanOrEqual(
        budget.effectiveBudgetMb,
      );
      expect(budget.childPoolMb).toBeGreaterThanOrEqual(0);
    }
  });

  it('flags a host too small for the documented minimum without clamping up', () => {
    expect(resolveDaemonMemoryBudget({ availableMemoryMb: 768 })).toMatchObject(
      {
        configuredBudgetMb: 384,
        effectiveBudgetMb: 384,
        insufficientMemory: true,
      },
    );
  });

  it('caps an explicit budget at host memory rather than believing it', () => {
    expect(
      resolveDaemonMemoryBudget({
        budgetMb: MAX_MEMORY_BUDGET_MB,
        availableMemoryMb: 2_048,
      }),
    ).toMatchObject({
      configuredBudgetMb: MAX_MEMORY_BUDGET_MB,
      effectiveBudgetMb: 2_048,
      budgetSource: 'flag',
    });
  });

  it('caps a derived budget at the flag maximum on a very large host', () => {
    // On a host above 2 TB the raw 50% fraction exceeds MAX_MEMORY_BUDGET_MB;
    // the configured figure must stay within what the flag itself accepts.
    const budget = resolveDaemonMemoryBudget({
      availableMemoryMb: 3 * 1024 * 1024,
    });
    expect(budget.configuredBudgetMb).toBe(MAX_MEMORY_BUDGET_MB);
    expect(budget.budgetSource).toBe('derived');
  });

  it('honors an explicit budget below host memory', () => {
    expect(
      resolveDaemonMemoryBudget({ budgetMb: 2_048, availableMemoryMb: 32_768 }),
    ).toMatchObject({
      configuredBudgetMb: 2_048,
      effectiveBudgetMb: 2_048,
      childPoolMb: 2_048 - 256,
    });
  });

  it('rejects an out-of-range explicit budget', () => {
    expect(() => resolveDaemonMemoryBudget({ budgetMb: 512 })).toThrow(
      TypeError,
    );
  });

  it('reports the constrained source through the seam', () => {
    const budget = resolveDaemonMemoryBudget({
      availableMemoryMb: 4_096,
      availableMemorySource: 'constrained',
    });
    expect(budget.availableMemorySource).toBe('constrained');
    expect(budget.availableMemoryMb).toBe(4_096);
  });
});

describe('normalizeMemoryBudgetMb', () => {
  it.each([0, -1, 1.5, Number.NaN, 1_023, MAX_MEMORY_BUDGET_MB + 1])(
    'rejects %p with a message naming the valid range',
    (value) => {
      expect(() => normalizeMemoryBudgetMb(value)).toThrow(
        new RegExp(`\\[${MIN_MEMORY_BUDGET_MB}, ${MAX_MEMORY_BUDGET_MB}\\]`),
      );
    },
  );

  it('accepts the boundaries', () => {
    expect(normalizeMemoryBudgetMb(MIN_MEMORY_BUDGET_MB)).toBe(
      MIN_MEMORY_BUDGET_MB,
    );
    expect(normalizeMemoryBudgetMb(MAX_MEMORY_BUDGET_MB)).toBe(
      MAX_MEMORY_BUDGET_MB,
    );
  });
});

describe('recommendedChildShareMb', () => {
  const budget = resolveDaemonMemoryBudget({ availableMemoryMb: 32_768 });

  it('is monotonically non-increasing in the child count', () => {
    let previous = Number.POSITIVE_INFINITY;
    for (let children = 1; children <= 25; children++) {
      const share = recommendedChildShareMb(budget, children);
      expect(share).toBeLessThanOrEqual(previous);
      previous = share;
    }
  });

  it('never exceeds the ceiling a child gets today', () => {
    for (const availableMemoryMb of [768, 1_024, 2_048, 8_192, 32_768]) {
      const scoped = resolveDaemonMemoryBudget({ availableMemoryMb });
      expect(recommendedChildShareMb(scoped, 1)).toBeLessThanOrEqual(
        legacyChildCeilingMb(availableMemoryMb),
      );
    }
  });

  it('bottoms out at the per-child floor', () => {
    expect(recommendedChildShareMb(budget, 10_000)).toBe(MIN_CHILD_HEAP_MB);
  });

  it('is capped at the 16 GB V8 ceiling on a very large host', () => {
    const large = resolveDaemonMemoryBudget({ availableMemoryMb: 128 * 1024 });
    expect(large.childPoolMb).toBeGreaterThan(MAX_CHILD_HEAP_MB);
    expect(recommendedChildShareMb(large, 1)).toBe(MAX_CHILD_HEAP_MB);
  });

  it('can sit below the per-child floor when the legacy ceiling is lower', () => {
    // On a small host the legacy ceiling sits below MIN_CHILD_HEAP_MB, and
    // the final Math.min(share, ceiling) wins over the clamp's floor.
    const small = resolveDaemonMemoryBudget({ availableMemoryMb: 768 });
    expect(small.legacyChildCeilingMb).toBeLessThan(MIN_CHILD_HEAP_MB);
    expect(recommendedChildShareMb(small, 1)).toBe(small.legacyChildCeilingMb);
    expect(recommendedChildShareMb(small, 1)).toBeLessThan(MIN_CHILD_HEAP_MB);
  });

  it('exposes the registered-vs-live gap it exists to measure', () => {
    // 25 registered but one live child: dividing by registrations would cut
    // that child ~25x for memory no dormant workspace is holding. This is why
    // the figure is reported and not applied.
    expect(recommendedChildShareMb(budget, 25)).toBe(614);
    expect(recommendedChildShareMb(budget, 1)).toBe(15_360);
  });
});

describe('detectAvailableMemoryMb', () => {
  it('prefers a cgroup constraint below the host total', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(32_768 * MB);
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(4_096 * MB);
    expect(detectAvailableMemoryMb()).toEqual({
      memoryMb: 4_096,
      source: 'constrained',
    });
  });

  it('ignores a cgroup v1 "unlimited" sentinel above the host total', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(32_768 * MB);
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(Number.MAX_SAFE_INTEGER);
    expect(detectAvailableMemoryMb()).toEqual({
      memoryMb: 32_768,
      source: 'host',
    });
  });

  it('falls back to the host total when unconstrained', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(8_192 * MB);
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(0);
    expect(detectAvailableMemoryMb()).toEqual({
      memoryMb: 8_192,
      source: 'host',
    });
  });

  it('treats a cgroup limit exactly equal to the host total as unconstrained', () => {
    vi.spyOn(os, 'totalmem').mockReturnValue(16_384 * MB);
    vi.spyOn(
      process as { constrainedMemory: () => number },
      'constrainedMemory',
    ).mockReturnValue(16_384 * MB);
    expect(detectAvailableMemoryMb()).toEqual({
      memoryMb: 16_384,
      source: 'host',
    });
  });
});

describe('isValidMemoryBudgetMb', () => {
  it('accepts the boundaries', () => {
    expect(isValidMemoryBudgetMb(MIN_MEMORY_BUDGET_MB)).toBe(true);
    expect(isValidMemoryBudgetMb(MAX_MEMORY_BUDGET_MB)).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, 1_023, MAX_MEMORY_BUDGET_MB + 1])(
    'rejects %p',
    (value) => {
      expect(isValidMemoryBudgetMb(value)).toBe(false);
    },
  );
});

describe('formatMemoryBudgetStderr', () => {
  it('formats a plain derived budget above the minimum', () => {
    const budget = resolveDaemonMemoryBudget({ availableMemoryMb: 32_768 });
    expect(formatMemoryBudgetStderr(budget)).toBe(
      'qwen serve: memory budget 16384 MB (derived, 32768 MB available via host)',
    );
  });

  it('formats the capped-down branch', () => {
    const budget = resolveDaemonMemoryBudget({
      budgetMb: MAX_MEMORY_BUDGET_MB,
      availableMemoryMb: 2_048,
    });
    expect(formatMemoryBudgetStderr(budget)).toContain(
      '; capped down from the configured',
    );
  });

  it('names the host floor on the derived insufficient path', () => {
    const budget = resolveDaemonMemoryBudget({ availableMemoryMb: 768 });
    const message = formatMemoryBudgetStderr(budget);
    expect(message).toContain('; below the 1024 MB minimum budget');
    expect(message).toContain(
      'a derived budget needs a host with at least ~2048 MB',
    );
    expect(message).toContain('pass --memory-budget-mb to override');
    expect(message).toContain('requires at least 1024 MB available');
  });

  it('does not mention the derived host floor on the flag path', () => {
    const budget = resolveDaemonMemoryBudget({
      budgetMb: 1_024,
      availableMemoryMb: 512,
    });
    const message = formatMemoryBudgetStderr(budget);
    expect(message).toContain('; below the 1024 MB minimum budget');
    expect(message).not.toContain('a derived budget needs');
  });
});
